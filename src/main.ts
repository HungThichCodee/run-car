import './style.css'
import QRCode from 'qrcode'
import { Game, type Controls, type CarState } from './game'
import { Room, Pairing, configured, type Player } from './network'
import { progress } from './track'

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const query = new URLSearchParams(location.search)
const controller = query.get('controller')
const empty: Controls = { steer: 0, throttle: 0, brake: 0, handbrake: false }
let game: Game | null = null
let room: Room | null = null
let pairing: Pairing | null = null
let raceFinished = false
let localState: CarState | null = null
const opponents = new Map<string, { name: string, progress: number, lastSeen: number, time?: number }>()
let toastTimer = 0
let lastLeaderboard = 0
function toast(message: string) {
  const target = el('toast'); target.textContent = message; target.hidden = false
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => target.hidden = true, 5000)
}
function setConnection(message: string) { el('connection').textContent = message; el('multiHint').textContent = message }
function showMenu(show: boolean) { el('menu').hidden = !show }
function time(value: number) {
  const minutes = Math.floor(value / 60).toString().padStart(2, '0')
  return minutes + ':' + (value % 60).toFixed(1).padStart(4, '0')
}
function leaderboard() {
  const target = el('leaderboard')
  target.replaceChildren()
  if (!room || room.players.length < 2) { target.hidden = true; return }
  target.hidden = false
  const values = room.players.map(p => ({ name: p.name, active: p.id === room?.id || performance.now() - (opponents.get(p.id)?.lastSeen || 0) < 3000, score: p.id === room?.id ? (localState ? localState.lap * Math.PI * 2 + progress(localState.x, localState.z) : 0) : (opponents.get(p.id)?.progress || 0), finish: opponents.get(p.id)?.time }))
  values.sort((a, b) => (a.finish === undefined ? 1 : 0) - (b.finish === undefined ? 1 : 0) || b.score - a.score)
  values.forEach((p, i) => { const div = document.createElement('div'); div.dataset.car = p.active ? 'online' : 'waiting'; div.textContent = (i + 1) + '. ' + p.name + (p.active ? ' 🚗' : ' · đang kết nối xe') + (p.finish === undefined ? '' : ' 🏁 ' + time(p.finish)); target.append(div) })
}
function renderPlayers(players: Player[]) {
  const list = el('players'); list.replaceChildren()
  for (const p of players) {
    const div = document.createElement('div')
    const name = document.createElement('span'); name.textContent = p.name + (p.host ? ' ★' : '')
    const ready = document.createElement('span'); ready.textContent = p.ready ? 'Sẵn sàng' : 'Đang chờ'
    div.append(name, ready); list.append(div)
  }
  const pending = players.filter(p => !p.ready)
  const me = players.find(p => p.id === room?.id)
  el<HTMLButtonElement>('startRace').disabled = !room?.host || players.length === 0 || pending.length > 0
  el('ready').textContent = me?.ready ? 'Hủy sẵn sàng' : 'Sẵn sàng'
  el('lobbyHelp').textContent = players.length === 0 ? 'Đang đồng bộ người chơi…' : room?.host
    ? pending.length ? 'Chờ ' + pending.map(p => p.name).join(', ') + ' bấm “Sẵn sàng”.' : 'Mọi người đã sẵn sàng. Bấm “Bắt đầu” để xuất phát.'
    : me?.ready ? 'Đã sẵn sàng. Chờ host bắt đầu cuộc đua.' : 'Bấm “Sẵn sàng” để host có thể bắt đầu.'
  leaderboard()
}
function attachRoom(next: Room) {
  room = next
  next.onPlayers = renderPlayers
  next.onStatus = message => { setConnection(message); toast(message) }
  next.onCar = state => { game?.setRemote(state); opponents.set(state.id, { name: state.name, progress: state.lap * Math.PI * 2 + progress(state.x, state.z), lastSeen: performance.now(), time: opponents.get(state.id)?.time }) }
  next.onStart = () => { game?.startRace(next.players.findIndex(p => p.id === next.id)); raceFinished = false; showMenu(false); toast('Xuất phát! Đua 3 vòng.') }
  next.onFinish = (id, t) => { const p = opponents.get(id); if (p) p.time = t; leaderboard(); toast((next.players.find(x => x.id === id)?.name || 'Người chơi') + ' đã về đích') }
}
async function enterRoom(host: boolean) {
  if (!configured) { toast('Chưa cấu hình multiplayer. Xem README để cài Supabase.'); return }
  const name = el<HTMLInputElement>('name').value.trim().slice(0, 24) || 'Tay đua'
  const code = host ? crypto.randomUUID().replaceAll('-', '').slice(0, 20) : el<HTMLInputElement>('roomCode').value.trim().toLowerCase()
  if (!/^[0-9a-f]{20}$/.test(code)) { toast('Mã phòng không hợp lệ'); return }
  if (room) await room.leave()
  const next = new Room(code, name, host); attachRoom(next)
  try {
    await next.join()
    el('lobby').hidden = false; el('roomLabel').textContent = code
    el<HTMLButtonElement>('startRace').hidden = !host
    el<HTMLButtonElement>('ready').hidden = host
    el<HTMLInputElement>('roomCode').value = code
    renderPlayers(next.players)
    toast('Chia sẻ mã phòng: ' + code)
  } catch (error) {
    setConnection('Không thể vào phòng')
    toast('Không thể vào phòng: ' + String(error))
    await next.leave(); room = null
  }
}
async function openPair() {
  if (!configured) { toast('Cần cấu hình Supabase để ghép điện thoại'); return }
  await pairing?.close(); pairing = new Pairing()
  pairing.onStatus = msg => { el('pairStatus').textContent = msg; toast(msg) }
  pairing.onControls = c => game?.setPhone(c)
  pairing.onConnected = () => {
    el('pairStatus').textContent = 'Điện thoại đã kết nối. Cửa sổ QR sẽ tự ẩn.'
    el('disconnectPhone').hidden = false
    toast('Điện thoại đã kết nối — dùng điện thoại để lái')
    window.setTimeout(() => el('pairDialog').hidden = true, 1500)
  }
  el('pairDialog').hidden = false; el('pairStatus').textContent = 'Đang tạo mã…'
  try {
    const link = await pairing.host()
    el<HTMLAnchorElement>('pairLink').href = link
    await QRCode.toCanvas(el<HTMLCanvasElement>('qr'), link, { width: 238, margin: 2, errorCorrectionLevel: 'M' })
    el('pairStatus').textContent = 'Quét để ghép nối'
  }
  catch (error) { el('pairStatus').textContent = 'Không tạo được QR: ' + String(error) }
}
function bindHold(button: HTMLElement, down: () => void, up: () => void) {
  button.addEventListener('pointerdown', e => { e.preventDefault(); button.setPointerCapture(e.pointerId); down() })
  button.addEventListener('pointerup', up)
  button.addEventListener('pointercancel', up)
  button.addEventListener('lostpointercapture', up)
}
async function setupGame() {
  el('phonePage').hidden = true
  setConnection(configured ? 'Multiplayer có thể kết nối' : 'Chưa cấu hình multiplayer')
  game = new Game(el('game'))
  game.onUpdate = (state, hud) => {
    localState = state
    el('speed').textContent = String(Math.round(hud.speed))
    el('lap').textContent = 'Vòng ' + hud.laps + '/3'
    el('timer').textContent = time(hud.time)
    el('checkpoint').textContent = 'Checkpoint ' + hud.checkpoint + '/4'
    room?.sendCar(state)
    if (room && performance.now() - lastLeaderboard > 500) { lastLeaderboard = performance.now(); leaderboard() }
    if (hud.finished && !raceFinished) { raceFinished = true; room?.finish(hud.time); toast('Về đích sau ' + time(hud.time) + '!') }
  }
  try { await game.init() } catch (error) { toast('Không thể khởi động game: ' + String(error)); return }
  el('openMenu').onclick = () => showMenu(true)
  el('closeMenu').onclick = () => showMenu(false)
  el('solo').onclick = () => { raceFinished = false; game?.startRace(); showMenu(false); toast('Đua 3 vòng. Nhấn R nếu bị kẹt.') }
  el('createRoom').onclick = () => enterRoom(true)
  el('joinRoom').onclick = () => enterRoom(false)
  el('ready').onclick = async () => {
    const current = room?.players.find(p => p.id === room?.id)
    try { await room?.ready(!current?.ready) }
    catch (error) { toast('Không đổi được trạng thái: ' + String(error)) }
  }
  el('startRace').onclick = async () => {
    const button = el<HTMLButtonElement>('startRace')
    button.disabled = true
    try { if (!await room?.start()) toast('Chờ mọi người sẵn sàng') }
    catch (error) { toast('Không bắt đầu được: ' + String(error)) }
    finally { if (room) renderPlayers(room.players) }
  }
  el('copyRoom').onclick = async () => {
    try { await navigator.clipboard.writeText(room?.code || ''); toast('Đã sao chép mã phòng') }
    catch { toast('Không sao chép được. Hãy chọn mã phòng ở trên.') }
  }
  el('leaveRoom').onclick = async () => { await room?.leave(); room = null; opponents.clear(); el('lobby').hidden = true; setConnection(configured ? 'Đã thoát phòng' : 'Chưa cấu hình multiplayer'); leaderboard() }
  el('pair').onclick = openPair
  el('closePair').onclick = () => el('pairDialog').hidden = true
  el('hidePair').onclick = () => el('pairDialog').hidden = true
  el('disconnectPhone').onclick = async () => {
    await pairing?.close(); pairing = null; game?.setPhone(null)
    el('disconnectPhone').hidden = true; toast('Đã ngắt điện thoại')
  }
  const touch: Controls = { ...empty }
  const update = () => game?.setTouch(touch)
  bindHold(el('left'), () => { touch.steer = -1; update() }, () => { touch.steer = 0; update() })
  bindHold(el('right'), () => { touch.steer = 1; update() }, () => { touch.steer = 0; update() })
  bindHold(el('gas'), () => { touch.throttle = 1; update() }, () => { touch.throttle = 0; update() })
  bindHold(el('brake'), () => { touch.brake = 1; update() }, () => { touch.brake = 0; update() })
  bindHold(el('handbrake'), () => { touch.handbrake = true; update() }, () => { touch.handbrake = false; update() })
  window.addEventListener('pagehide', () => { game?.dispose(); room?.leave(); pairing?.close() }, { once: true })
}
async function setupPhone(token: string) {
  el('game').hidden = true; el('menu').hidden = true; el('hud').hidden = true; el('leaderboard').hidden = true
  document.querySelector<HTMLElement>('.topbar')!.hidden = true
  document.querySelector<HTMLElement>('.touchControls')!.hidden = true
  el('phonePage').hidden = false
  const status = (message: string) => el('phoneStatus').textContent = message
  if (!configured) { status('Chưa cấu hình multiplayer'); return }
  pairing = new Pairing(); pairing.onStatus = status; pairing.onConnected = () => status('Đã ghép nối')
  try { await pairing.phone(token) } catch (error) { status('Ghép nối thất bại: ' + String(error)); return }
  let baseline = 0, angle = 0, smooth = 0, tilt = false
  const controls: Controls = { ...empty }
  const send = () => pairing?.sendControls(controls)
  const orientation = (event: DeviceOrientationEvent) => {
    if (event.gamma === null) return
    angle = event.gamma
    if (!tilt) return
    const sensitivity = Number(el<HTMLInputElement>('sensitivity').value)
    const deadzone = Number(el<HTMLInputElement>('deadzone').value)
    const smoothing = Number(el<HTMLInputElement>('smoothing').value)
    let steer = Math.abs(angle - baseline) < deadzone ? 0 : Math.max(-1, Math.min(1, (angle - baseline) / 35 * sensitivity))
    smooth += (steer - smooth) * smoothing
    controls.steer = smooth; send()
  }
  el('sensor').onclick = async () => {
    const api = DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> }
    try {
      if (api.requestPermission && await api.requestPermission() !== 'granted') throw new Error('Quyền cảm biến bị từ chối')
      window.addEventListener('deviceorientation', orientation)
      tilt = true; status('Cảm biến đang hoạt động')
    } catch { status('Không dùng được cảm biến. Dùng nút ◀ ▶.') }
  }
  el('calibrate').onclick = () => { baseline = angle; smooth = 0; status('Đã hiệu chỉnh tư thế thẳng') }
  bindHold(el('phoneLeft'), () => { tilt = false; controls.steer = -1; send() }, () => { controls.steer = 0; send() })
  bindHold(el('phoneRight'), () => { tilt = false; controls.steer = 1; send() }, () => { controls.steer = 0; send() })
  bindHold(el('phoneGas'), () => { controls.throttle = 1; send() }, () => { controls.throttle = 0; send() })
  bindHold(el('phoneBrake'), () => { controls.brake = 1; send() }, () => { controls.brake = 0; send() })
  bindHold(el('phoneDrift'), () => { controls.handbrake = true; send() }, () => { controls.handbrake = false; send() })
  const heartbeat = window.setInterval(send, 100)
  window.addEventListener('pagehide', () => { clearInterval(heartbeat); window.removeEventListener('deviceorientation', orientation); pairing?.close() }, { once: true })
}
if (controller) setupPhone(controller); else setupGame()
