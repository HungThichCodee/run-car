import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

export const ROAD_HALF_WIDTH = 6
const TAU = Math.PI * 2
const SEGMENTS = 144
const SEARCH_SEGMENTS = 288

// An original mountain circuit: two hairpins, an S bend, a ridge and a valley.
const route = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 5, 0),
  new THREE.Vector3(25, 5.5, -8),
  new THREE.Vector3(53, 9, -25),
  new THREE.Vector3(76, 14, -6),
  new THREE.Vector3(67, 13, 27),
  new THREE.Vector3(39, 8, 38),
  new THREE.Vector3(13, 5, 20),
  new THREE.Vector3(-12, 7, 31),
  new THREE.Vector3(-44, 13, 18),
  new THREE.Vector3(-56, 15, -16),
  new THREE.Vector3(-33, 8, -42),
  new THREE.Vector3(-3, 5, -34)
], true, 'centripetal')
const centerSamples = Array.from({ length: SEARCH_SEGMENTS + 1 }, (_, i) => route.getPoint(i / SEARCH_SEGMENTS))

function unit(t: number) { return ((t % TAU) + TAU) % TAU / TAU }
export function tangent(t: number) { return route.getTangent(unit(t)).normalize() }
export function point(t: number, offset = 0): THREE.Vector3 {
  const p = route.getPoint(unit(t))
  const d = tangent(t)
  const length = Math.hypot(d.x, d.z)
  p.x += d.z / length * offset
  p.z -= d.x / length * offset
  return p
}
export function tangentAngle(t: number) {
  const d = tangent(t)
  return Math.atan2(d.x, d.z)
}

function nearest(x: number, z: number) {
  let best = Infinity, bestIndex = 0, bestFraction = 0
  for (let i = 0; i < SEARCH_SEGMENTS; i++) {
    const a = centerSamples[i], b = centerSamples[i + 1]
    const dx = b.x - a.x, dz = b.z - a.z
    const fraction = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1)
    const px = a.x + dx * fraction, pz = a.z + dz * fraction
    const distance = (x - px) ** 2 + (z - pz) ** 2
    if (distance < best) { best = distance; bestIndex = i; bestFraction = fraction }
  }
  const a = centerSamples[bestIndex], b = centerSamples[bestIndex + 1]
  return { angle: (bestIndex + bestFraction) / SEARCH_SEGMENTS * TAU, distance: Math.sqrt(best), height: THREE.MathUtils.lerp(a.y, b.y, bestFraction) }
}
export function progress(x: number, z: number) { return nearest(x, z).angle }

function terrainHeight(x: number, z: number) {
  const nearby = nearest(x, z)
  const hills = -.5 + 2.5 * Math.sin(x * .047) * Math.cos(z * .052) + 1.8 * Math.sin((x + z) * .035)
  const blend = THREE.MathUtils.clamp((22 - nearby.distance) / 15, 0, 1)
  const smooth = blend * blend * (3 - 2 * blend)
  return THREE.MathUtils.lerp(hills, nearby.height - 1.35, smooth)
}

function geometry(vertices: number[], indices: number[]) {
  const shape = new THREE.BufferGeometry()
  shape.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  shape.setIndex(indices)
  shape.computeVertexNormals()
  return shape
}

function ribbon(scene: THREE.Scene, world: RAPIER.World, halfWidth: number, lift: number, color: number, friction: number) {
  const vertices: number[] = [], indices: number[] = []
  for (let i = 0; i <= SEGMENTS; i++) {
    const angle = i / SEGMENTS * TAU
    for (const side of [-halfWidth, halfWidth]) {
      const p = point(angle, side)
      vertices.push(p.x, p.y + lift, p.z)
    }
    if (i < SEGMENTS) {
      const k = i * 2
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
  }
  const mesh = new THREE.Mesh(geometry(vertices, indices), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: .92 }))
  mesh.receiveShadow = true; scene.add(mesh)
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(vertices), new Uint32Array(indices)).setFriction(friction))
}

function terrain(scene: THREE.Scene, world: RAPIER.World) {
  const vertices: number[] = [], indices: number[] = [], colors: number[] = []
  const nx = 76, nz = 66
  const low = new THREE.Color(0x315e40), high = new THREE.Color(0x71916b), stone = new THREE.Color(0x9b937e)
  for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix <= nx; ix++) {
    const x = -112 + ix * 224 / nx, z = -96 + iz * 192 / nz
    const y = terrainHeight(x, z)
    vertices.push(x, y, z)
    const color = low.clone().lerp(high, THREE.MathUtils.clamp((y + 3) / 19, 0, 1))
    if (y > 10) color.lerp(stone, (y - 10) / 15)
    colors.push(color.r, color.g, color.b)
    if (iz < nz && ix < nx) {
      const k = iz * (nx + 1) + ix
      indices.push(k, k + nx + 1, k + 1, k + 1, k + nx + 1, k + nx + 2)
    }
  }
  const shape = geometry(vertices, indices)
  shape.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const mesh = new THREE.Mesh(shape, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 1 }))
  mesh.receiveShadow = true; scene.add(mesh)
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(vertices), new Uint32Array(indices)).setFriction(.85))
}

export function buildTrack(scene: THREE.Scene, world: RAPIER.World) {
  terrain(scene, world)
  ribbon(scene, world, ROAD_HALF_WIDTH + 1.65, .025, 0x9d7855, 1)
  ribbon(scene, world, ROAD_HALF_WIDTH, .085, 0x263541, 1.25)

  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffe7a4, emissive: 0x30210c })
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xf4e9d6 })
  const railMat = new THREE.MeshStandardMaterial({ color: 0xe7755b, metalness: .2, roughness: .55 })
  const railGeo = new THREE.BoxGeometry(.35, .8, 2.7)
  const edgeGeo = new THREE.BoxGeometry(.13, .045, 1.35)
  const lineGeo = new THREE.BoxGeometry(.17, .045, 1.6)
  for (let i = 0; i < SEGMENTS; i++) {
    const angle = (i + .5) / SEGMENTS * TAU, heading = tangentAngle(angle)
    if (i % 3 !== 0) {
      const p = point(angle)
      const mark = new THREE.Mesh(lineGeo, stripeMat)
      mark.position.set(p.x, p.y + .16, p.z); mark.rotation.y = heading; scene.add(mark)
    }
    for (const side of [-1, 1]) {
      if (i % 2 === 0) {
        const p = point(angle, side * (ROAD_HALF_WIDTH - .16))
        const line = new THREE.Mesh(edgeGeo, edgeMat)
        line.position.set(p.x, p.y + .16, p.z); line.rotation.y = heading; scene.add(line)
        const b = point(angle, side * (ROAD_HALF_WIDTH + 1.05))
        const rail = new THREE.Mesh(railGeo, railMat)
        rail.position.set(b.x, b.y + .5, b.z); rail.rotation.y = heading
        rail.castShadow = true; scene.add(rail)
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.x, b.y + .5, b.z).setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }))
        world.createCollider(RAPIER.ColliderDesc.cuboid(.18, .4, 1.35).setRestitution(.15), body)
      }
    }
  }
  // A checkered grid and visible checkpoint gates give the winding route structure.
  const white = new THREE.MeshStandardMaterial({ color: 0xf6f3e7 }), dark = new THREE.MeshStandardMaterial({ color: 0x141d24 })
  for (let j = -6; j < 6; j++) for (let k = 0; k < 2; k++) {
    const p = point(k * .006, j + .5)
    const tile = new THREE.Mesh(new THREE.BoxGeometry(.97, .035, .92), (j + k) % 2 ? white : dark)
    tile.position.set(p.x, p.y + .18, p.z); tile.rotation.y = tangentAngle(0); scene.add(tile)
  }
  const archMat = new THREE.MeshStandardMaterial({ color: 0x173445, metalness: .35 })
  const bannerMat = new THREE.MeshStandardMaterial({ color: 0xc4f76b, emissive: 0x527631, emissiveIntensity: .4 })
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2
    const group = new THREE.Group()
    const center = point(angle)
    group.position.copy(center); group.rotation.y = tangentAngle(angle)
    for (const x of [-6.8, 6.8]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(.34, 4.7, .34), archMat)
      post.position.set(x, 2.35, 0); post.castShadow = true; group.add(post)
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(14, .75, .55), i === 0 ? bannerMat : archMat)
    top.position.y = 4.7; top.castShadow = true; group.add(top)
    const strip = new THREE.Mesh(new THREE.BoxGeometry(13.5, .12, .6), bannerMat)
    strip.position.y = 4.3; group.add(strip)
    scene.add(group)
  }

  const dynamic: { mesh: THREE.Mesh, body: RAPIER.RigidBody }[] = []
  const boxGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2), coneGeo = new THREE.ConeGeometry(.47, 1.2, 9)
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xffa039 }), boxMat = new THREE.MeshStandardMaterial({ color: 0xbf7453 })
  for (let i = 0; i < 15; i++) {
    const angle = .35 + i * .38, offset = i % 3 === 0 ? -2.3 : i % 3 === 1 ? 2.3 : .3
    const p = point(angle, offset), cone = i % 2 === 0
    const mesh = new THREE.Mesh(cone ? coneGeo : boxGeo, cone ? coneMat : boxMat)
    mesh.position.set(p.x, p.y + .8, p.z); mesh.castShadow = true; scene.add(mesh)
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y + .8, p.z).setLinearDamping(.6).setCcdEnabled(true))
    world.createCollider(cone ? RAPIER.ColliderDesc.cone(.6, .47).setDensity(.35) : RAPIER.ColliderDesc.cuboid(.6, .6, .6).setDensity(.8), body)
    dynamic.push({ mesh, body })
  }
  const moving = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 1.8), new THREE.MeshStandardMaterial({ color: 0xe8c563, metalness: .2 }))
  moving.castShadow = true; scene.add(moving)
  const initial = point(2.55)
  const movingBody = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(initial.x, initial.y + .75, initial.z))
  world.createCollider(RAPIER.ColliderDesc.cuboid(.9, .7, .9), movingBody)

  for (const [angle, color] of [[1.2, 0xba7440], [4.35, 0x9fd7e4]] as const) {
    const p = point(angle)
    const zone = new THREE.Mesh(new THREE.CircleGeometry(3.25, 32), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: .68, side: THREE.DoubleSide }))
    zone.rotation.x = -Math.PI / 2; zone.position.set(p.x, p.y + .17, p.z); scene.add(zone)
  }

  let seed = 7324
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x654c36 }), pineMat = new THREE.MeshStandardMaterial({ color: 0x214b3d }), pineLight = new THREE.MeshStandardMaterial({ color: 0x39705a })
  const trunkGeo = new THREE.CylinderGeometry(.2, .3, 2, 6), crownGeo = new THREE.ConeGeometry(1.5, 4, 7)
  const rockGeo = new THREE.DodecahedronGeometry(1.2, 0), rockMat = new THREE.MeshStandardMaterial({ color: 0x8a8e84, roughness: 1, flatShading: true })
  for (let i = 0; i < 105; i++) {
    const x = -100 + random() * 200, z = -85 + random() * 170
    if (nearest(x, z).distance < 11) continue
    const y = terrainHeight(x, z)
    if (i % 5 === 0) {
      const rock = new THREE.Mesh(rockGeo, rockMat)
      rock.position.set(x, y + .6, z); rock.scale.set(.7 + random(), .45 + random(), .7 + random()); rock.castShadow = true; scene.add(rock)
    } else {
      const scale = .8 + random() * .8
      const trunk = new THREE.Mesh(trunkGeo, trunkMat), crown = new THREE.Mesh(crownGeo, i % 3 ? pineMat : pineLight)
      trunk.position.set(x, y + scale, z); trunk.scale.setScalar(scale)
      crown.position.set(x, y + scale * 3.2, z); crown.scale.setScalar(scale); crown.castShadow = true
      scene.add(trunk, crown)
    }
  }
  for (let i = 0; i < 12; i++) {
    const angle = i / 12 * TAU
    const x = Math.cos(angle) * 120, z = Math.sin(angle) * 103
    const mountain = new THREE.Mesh(new THREE.ConeGeometry(18 + i % 4 * 7, 30 + i % 5 * 7, 5), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x6f8b83 : 0x81958c, flatShading: true }))
    mountain.position.set(x, 6, z); mountain.receiveShadow = true; scene.add(mountain)
  }
  const stand = new THREE.Group()
  const standPos = point(.08, -17)
  stand.position.set(standPos.x, standPos.y - .4, standPos.z); stand.rotation.y = tangentAngle(.08)
  const platform = new THREE.Mesh(new THREE.BoxGeometry(16, 1.2, 8), new THREE.MeshStandardMaterial({ color: 0x4d5960 }))
  platform.position.y = 1; platform.castShadow = true; stand.add(platform)
  for (let i = 0; i < 4; i++) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(15, .6, 1.3), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xe79a56 : 0xd6cf9b }))
    seat.position.set(0, 1.8 + i * .65, -2.4 + i * 1.6); seat.castShadow = true; stand.add(seat)
  }
  scene.add(stand)

  return {
    update(time: number) {
      const p = point(2.55, Math.sin(time * .7) * 3)
      movingBody.setNextKinematicTranslation({ x: p.x, y: p.y + .75, z: p.z })
      moving.position.set(p.x, p.y + .75, p.z)
      for (const item of dynamic) {
        const p = item.body.translation(), q = item.body.rotation()
        item.mesh.position.set(p.x, p.y, p.z); item.mesh.quaternion.set(q.x, q.y, q.z, q.w)
      }
    }
  }
}
