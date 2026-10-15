// Browser smoke test for the built Pages site. The online part uses the
// project's public Supabase client variables and separate browser processes.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const repo = (process.env.GITHUB_REPOSITORY || 'HungThichCodee/run-car').split('/').pop()
const site = 'http://127.0.0.1:4175/' + repo + '/'
const online = Boolean(process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_PUBLISHABLE_KEY)
const browserBinary = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(path => path && existsSync(path))
if (!browserBinary) throw new Error('Chromium/Chrome is required for the smoke test')
let preview, browser, guestBrowser, phoneBrowser, profile, guestProfile, phoneProfile
const tabs = []
let stage = 'starting browser'

class Tab {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.exceptions = []
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id) {
        this.pending.get(message.id)?.(message)
        this.pending.delete(message.id)
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails.text)
      }
    })
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      this.pending.set(id, resolve)
      try { this.ws.send(JSON.stringify({ id, method, params })) }
      catch (error) { this.pending.delete(id); reject(error) }
    })
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.error || result.result?.exceptionDetails) throw new Error('Browser expression failed: ' + expression.slice(0, 90))
    return result.result?.result?.value
  }
  async wait(expression, timeout = 25000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if (await this.evaluate(expression)) return
      await pause(250)
    }
    throw new Error('Browser timed out waiting for ' + expression)
  }
  async click(selector) {
    await this.evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()')
  }
  close() { this.ws.close() }
}

async function newTab(debugPort, url) {
  const response = await fetch('http://127.0.0.1:' + debugPort + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
  if (!response.ok) throw new Error('Could not create browser tab')
  const page = await response.json()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const tab = new Tab(ws)
  tabs.push(tab)
  await tab.call('Runtime.enable')
  await tab.wait('document.readyState === "complete"')
  return tab
}

async function launchBrowser(prefix) {
  const profile = mkdtempSync(join(tmpdir(), prefix))
  const browser = spawn(browserBinary, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' })
  let debugPort
  for (let i = 0; i < 80; i++) {
    try {
      debugPort = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
      if (debugPort) break
    } catch { /* Wait for Chrome. */ }
    await pause(250)
  }
  if (!debugPort) { browser.kill(); rmSync(profile, { recursive: true, force: true }); throw new Error('Chrome DevTools did not start') }
  return { browser, profile, debugPort }
}

async function main() {
  preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4175', '--strictPort'], {
    cwd: process.cwd(),
    env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || 'HungThichCodee/run-car' },
    stdio: 'ignore'
  })
  let ready = false
  for (let i = 0; i < 60; i++) {
    try { const response = await fetch(site); if (response.ok) { ready = true; break } }
    catch { /* Wait for Vite. */ }
    await pause(250)
  }
  if (!ready) throw new Error('Vite preview did not start')

  const hostProcess = await launchBrowser('run-car-smoke-')
  browser = hostProcess.browser; profile = hostProcess.profile
  const debugPort = hostProcess.debugPort
  const host = await newTab(debugPort, site)
  stage = 'loading solo game'
  await host.wait("document.querySelector('#game canvas') !== null", 30000)
  await host.click('#solo')
  await host.wait("document.querySelector('#menu').hidden")
  console.log('PASS: 3D scene and solo race started')
  if (host.exceptions.length) throw new Error('Browser exception: ' + host.exceptions.join('; '))
  if (!online) { console.log('SKIP: multiplayer and phone pairing (Supabase variables absent)'); return }

  stage = 'creating room'
  await host.click('#openMenu')
  await host.click('#createRoom')
  await host.wait("document.querySelector('#lobby').hidden === false", 30000)
  const code = await host.evaluate("document.querySelector('#roomLabel').textContent")
  if (!/^[0-9a-f]{20}$/.test(code)) throw new Error('Room code is invalid')
  stage = 'joining second player'
  const guestProcess = await launchBrowser('run-car-guest-smoke-')
  guestBrowser = guestProcess.browser; guestProfile = guestProcess.profile
  const guest = await newTab(guestProcess.debugPort, site)
  await guest.wait("document.querySelector('#game canvas') !== null", 30000)
  await guest.evaluate("document.querySelector('#roomCode').value = " + JSON.stringify(code))
  await guest.click('#joinRoom')
  await guest.wait("document.querySelector('#lobby').hidden === false", 30000)
  await host.wait("document.querySelectorAll('#players div').length === 2", 30000)
  stage = 'synchronizing ready state'
  await guest.click('#ready')
  await host.wait("document.querySelector('#startRace').disabled === false", 30000)
  stage = 'starting two-player race'
  await host.click('#startRace')
  await Promise.all([
    host.wait("document.querySelector('#menu').hidden === true", 10000),
    guest.wait("document.querySelector('#menu').hidden === true", 10000)
  ])
  stage = 'receiving both cars'
  await Promise.all([
    host.wait("document.querySelectorAll('#leaderboard [data-car=online]').length === 2", 10000),
    guest.wait("document.querySelectorAll('#leaderboard [data-car=online]').length === 2", 10000)
  ])
  await pause(3500)
  if (!await host.evaluate("document.querySelectorAll('#leaderboard [data-car=online]').length === 2") ||
      !await guest.evaluate("document.querySelectorAll('#leaderboard [data-car=online]').length === 2")) {
    throw new Error('A remote car stopped receiving position updates')
  }
  console.log('PASS: two players joined, started race, and see both cars')

  stage = 'pairing phone'
  await host.call('Page.bringToFront')
  await host.click('#openMenu')
  await host.click('#pair')
  await host.wait("document.querySelector('#pairLink').href.includes('controller=')", 30000)
  const link = await host.evaluate("document.querySelector('#pairLink').href")
  const phoneProcess = await launchBrowser('run-car-phone-smoke-')
  phoneBrowser = phoneProcess.browser; phoneProfile = phoneProcess.profile
  const phone = await newTab(phoneProcess.debugPort, link)
  await phone.wait("document.querySelector('#phoneStatus').textContent.includes('Đã ghép nối')", 30000)
  await host.wait("document.querySelector('#pairStatus').textContent.includes('Điện thoại đã kết nối')", 30000)
  await host.wait("document.querySelector('#pairDialog').hidden === true", 5000)
  await host.call('Page.bringToFront')

  stage = 'receiving phone throttle'
  const rect = await phone.evaluate("(() => { const r = document.querySelector('#phoneGas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()")
  await phone.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  try { await host.wait("Number(document.querySelector('#speed').textContent) > 10", 5000) }
  catch {
    const speed = await host.evaluate("document.querySelector('#speed').textContent")
    const hostStatus = await host.evaluate("document.querySelector('#pairStatus').textContent")
    const phoneStatus = await phone.evaluate("document.querySelector('#phoneStatus').textContent")
    throw new Error('Phone gas did not move host; speed=' + speed + ', host=' + hostStatus + ', phone=' + phoneStatus)
  }
  await phone.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  console.log('PASS: phone WebRTC channel controlled host car')
  if (host.exceptions.length || guest.exceptions.length || phone.exceptions.length) throw new Error('Browser exception during online test')
}

try { await main() }
catch (error) {
  const message = (stage + ': ' + error.message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  console.error('::error title=Browser smoke::' + message)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Browser smoke failed at **' + stage + '**: ' + error.message + '\n')
  throw error
}
finally {
  for (const tab of tabs) tab.close()
  phoneBrowser?.kill()
  guestBrowser?.kill()
  browser?.kill()
  preview?.kill()
  await pause(300)
  if (profile) rmSync(profile, { recursive: true, force: true })
  if (guestProfile) rmSync(guestProfile, { recursive: true, force: true })
  if (phoneProfile) rmSync(phoneProfile, { recursive: true, force: true })
}
