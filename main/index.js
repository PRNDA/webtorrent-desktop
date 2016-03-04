/* global URL, Blob */

var airplay = require('airplay-js')
var chromecasts = require('chromecasts')()
var createTorrent = require('create-torrent')
var dragDrop = require('drag-drop')
var electron = require('electron')
var networkAddress = require('network-address')
var path = require('path')
var throttle = require('throttleit')
var torrentPoster = require('./lib/torrent-poster')
var WebTorrent = require('webtorrent')

var createElement = require('virtual-dom/create-element')
var diff = require('virtual-dom/diff')
var patch = require('virtual-dom/patch')

var App = require('./views/app')

var HEADER_HEIGHT = 38

// Force use of webtorrent trackers on all torrents
global.WEBTORRENT_ANNOUNCE = createTorrent.announceList
  .map(function (arr) {
    return arr[0]
  })
  .filter(function (url) {
    return url.indexOf('wss://') === 0 || url.indexOf('ws://') === 0
  })

var state = global.state = {
  server: null, /* local WebTorrent-to-HTTP server */
  player: null, /* 'local', 'airplay', or 'chromecast'. persists across videos */
  view: {
    url: '/',
    dock: {
      badge: 0,
      progress: 0
    },
    devices: {
      airplay: null, /* airplay client. finds and manages AppleTVs */
      chromecast: null /* chromecast client. finds and manages Chromecasts */
    },
    client: null, /* the WebTorrent client */
    // history: [], /* track how we got to the current view. enables Back button */
    // historyIndex: 0,
    isFocused: true,
    mainWindowBounds: null, /* x y width height */
    title: 'WebTorrent' /* current window title */
  },
  video: {
    isPaused: false
  }
}

var client, currentVDom, rootElement, updateThrottled

function init () {
  client = global.client = new WebTorrent()
  client.on('warning', onWarning)
  client.on('error', onError)
  state.view.client = client

  currentVDom = App(state, dispatch)
  rootElement = createElement(currentVDom)
  document.body.appendChild(rootElement)

  updateThrottled = throttle(update, 1000)

  dragDrop('body', onFiles)

  chromecasts.on('update', function (player) {
    state.view.chromecast = player
    update()
  })

  airplay.createBrowser().on('deviceOn', function (player) {
    state.view.devices.airplay = player
  }).start()

  document.addEventListener('paste', function () {
    electron.ipcRenderer.send('addTorrentFromPaste')
  })

  window.addEventListener('focus', function () {
    state.view.isFocused = true
    if (state.view.dock.badge > 0) electron.ipcRenderer.send('setBadge', '')
    state.view.dock.badge = 0
  })

  window.addEventListener('blur', function () {
    state.view.isFocused = false
  })
}
init()

function update () {
  var newVDom = App(state, dispatch)
  var patches = diff(currentVDom, newVDom)
  rootElement = patch(rootElement, patches)
  currentVDom = newVDom

  updateDockIcon()
}

setInterval(function () {
  updateThrottled()
}, 1000)

function updateDockIcon () {
  var progress = state.view.client.progress
  var activeTorrentsExist = state.view.client.torrents.some(function (torrent) {
    return torrent.progress !== 1
  })
  // Hide progress bar when client has no torrents, or progress is 100%
  if (!activeTorrentsExist || progress === 1) {
    progress = -1
  }
  if (progress !== state.view.dock.progress) {
    state.view.dock.progress = progress
    electron.ipcRenderer.send('setProgress', progress)
  }
}

function dispatch (action, ...args) {
  console.log('dispatch: %s %o', action, args)
  if (action === 'addTorrent') {
    addTorrent(args[0] /* torrentId */)
  }
  if (action === 'seed') {
    seed(args[0] /* files */)
  }
  if (action === 'openPlayer') {
    openPlayer(args[0] /* torrent */)
  }
  if (action === 'deleteTorrent') {
    deleteTorrent(args[0] /* torrent */)
  }
  if (action === 'openChromecast') {
    openChromecast(args[0] /* torrent */)
  }
  if (action === 'openAirplay') {
    openAirplay(args[0] /* torrent */)
  }
  if (action === 'setDimensions') {
    setDimensions(args[0] /* dimensions */)
  }
  if (action === 'back') {
    if (state.view.url === '/player') {
      restoreBounds()
      closeServer()
    }
    state.view.url = '/'
    update()
  }
  if (action === 'playPause') {
    state.video.isPaused = !state.video.isPaused
    update()
  }
}

electron.ipcRenderer.on('addTorrent', function (e, torrentId) {
  addTorrent(torrentId)
})

electron.ipcRenderer.on('seed', function (e, files) {
  seed(files)
})

function onFiles (files) {
  // .torrent file = start downloading the torrent
  files.filter(isTorrentFile).forEach(function (torrentFile) {
    dispatch('addTorrent', torrentFile)
  })

  // everything else = seed these files
  dispatch('seed', files.filter(isNotTorrentFile))
}

function isTorrentFile (file) {
  var extname = path.extname(file.name).toLowerCase()
  return extname === '.torrent'
}

function isNotTorrentFile (file) {
  return !isTorrentFile(file)
}

function addTorrent (torrentId) {
  var torrent = client.add(torrentId)
  addTorrentEvents(torrent)
}

function seed (files) {
  if (files.length === 0) return
  var torrent = client.seed(files)
  addTorrentEvents(torrent)
}

function addTorrentEvents (torrent) {
  torrent.on('infoHash', update)
  torrent.on('done', function () {
    if (!state.view.isFocused) {
      state.view.dock.badge += 1
      electron.ipcRenderer.send('setBadge', state.view.dock.badge)
    }
    update()
  })
  torrent.on('download', updateThrottled)
  torrent.on('upload', updateThrottled)
  torrent.on('ready', function () {
    torrentReady(torrent)
  })
  update()
}

function torrentReady (torrent) {
  torrentPoster(torrent, function (err, buf) {
    if (err) return onError(err)
    torrent.posterURL = URL.createObjectURL(new Blob([ buf ], { type: 'image/png' }))
    update()
  })
  update()
}

function startServer (torrent, cb) {
  // use largest file
  var index = torrent.files.indexOf(torrent.files.reduce(function (a, b) {
    return a.length > b.length ? a : b
  }))

  var server = torrent.createServer()
  server.listen(0, function () {
    var port = server.address().port
    var urlSuffix = ':' + port + '/' + index
    state.server = {
      server: server,
      localURL: 'http://localhost' + urlSuffix,
      networkURL: 'http://' + networkAddress() + urlSuffix
    }
    cb()
  })
}

function closeServer () {
  state.server.server.destroy()
  state.server = null
}

function openPlayer (torrent) {
  startServer(torrent, function () {
    state.view.url = '/player'
    update()
  })
}

function deleteTorrent (torrent) {
  console.log('Deleting %o', torrent)
  torrent.isDeleting = true
  update()
  state.view.client.remove(torrent.infoHash, function () {
    console.log('Deleted torrent ' + torrent.infoHash)
    update()
  })
}

function openChromecast (torrent) {
  startServer(torrent, function () {
    state.view.chromecast.play(state.server.networkURL, { title: 'WebTorrent — ' + torrent.name })
    state.view.chromecast.on('error', function (err) {
      err.message = 'Chromecast: ' + err.message
      onError(err)
    })
    update()
  })
}

function openAirplay (torrent) {
  startServer(torrent, function () {
    state.view.devices.airplay.play(state.server.networkURL, 0, function () {})
    // TODO: handle airplay errors
    update()
  })
}

function setDimensions (dimensions) {
  state.view.mainWindowBounds = electron.remote.getCurrentWindow().getBounds()

  // Limit window size to screen size
  var workAreaSize = electron.remote.screen.getPrimaryDisplay().workAreaSize
  var aspectRatio = dimensions.width / dimensions.height

  var scaleFactor = Math.min(
    Math.min(workAreaSize.width / dimensions.width, 1),
    Math.min(workAreaSize.height / dimensions.height, 1)
  )

  var width = Math.floor(dimensions.width * scaleFactor)
  var height = Math.floor(dimensions.height * scaleFactor)

  height += HEADER_HEIGHT

  // Center window on screen
  var x = Math.floor((workAreaSize.width - width) / 2)
  var y = Math.floor((workAreaSize.height - height) / 2)

  electron.ipcRenderer.send('setAspectRatio', aspectRatio, { width: 0, height: HEADER_HEIGHT })
  electron.ipcRenderer.send('setBounds', { x, y, width, height })
}

function restoreBounds () {
  electron.ipcRenderer.send('setAspectRatio', 0)
  electron.ipcRenderer.send('setBounds', state.view.mainWindowBounds, true)
}

function onError (err) {
  console.error(err.stack)
  window.alert(err.message || err)
  update()
}

function onWarning (err) {
  console.log('warning: %s', err.message)
}
