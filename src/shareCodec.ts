import { compressToBase64, decompressFromBase64 } from 'lz-string'
import type { Geometry, Position } from 'geojson'

export type ShareFeature = {
  id: string
  name: string
  type: string
  lat: number
  lng: number
  displayName?: string
  geometry?: Geometry
}

export type ShareProject = {
  id: string
  name: string
  continent: string
  features: ShareFeature[]
  mapLayer: 'blind' | 'normal'
  displayMode: 'shape' | 'points'
  testOrder: string[]
  testIndex: number
  stats: { answered: number; correct: number; wrong: number }
}

export const SHARE_URL_LIMIT = 12_000
const SHARED_SCHEMA_PREFIX = 's2_'
const LEGACY_COMPRESSED_PREFIX = 'lz1_'
const SIMPLIFY_TOLERANCE_DEGREES = 0.01
const COORDINATE_DECIMALS = 5

type PackedGeometry = [number, unknown]
type PackedFeature = [string, string, number, number, PackedGeometry?]
type PackedProject = [2, string, string, 'blind' | 'normal', 'shape' | 'points', PackedFeature[]]

const toBase64Url = (value: string) => {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string) => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

const compress = (value: string) => toBase64Url(compressToBase64(value))

const perpendicularDistance = (point: Position, start: Position, end: Position, longitudeScale: number) => {
  const px = point[0] * longitudeScale
  const py = point[1]
  const sx = start[0] * longitudeScale
  const sy = start[1]
  const ex = end[0] * longitudeScale
  const ey = end[1]
  const dx = ex - sx
  const dy = ey - sy
  const ratio = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (sx + ratio * dx), py - (sy + ratio * dy))
}

const simplifyOpenLine = (positions: Position[], tolerance: number, longitudeScale: number): Position[] => {
  if (positions.length <= 2) return positions.map(roundPosition)
  const keep = new Uint8Array(positions.length)
  keep[0] = 1
  keep[positions.length - 1] = 1
  const stack: Array<[number, number]> = [[0, positions.length - 1]]
  while (stack.length) {
    const [startIndex, endIndex] = stack.pop()!
    let furthestDistance = tolerance
    let furthestIndex = -1
    for (let index = startIndex + 1; index < endIndex; index++) {
      const distance = perpendicularDistance(positions[index], positions[startIndex], positions[endIndex], longitudeScale)
      if (distance > furthestDistance) {
        furthestDistance = distance
        furthestIndex = index
      }
    }
    if (furthestIndex >= 0) {
      keep[furthestIndex] = 1
      stack.push([startIndex, furthestIndex], [furthestIndex, endIndex])
    }
  }
  return positions.filter((_, index) => keep[index]).map(roundPosition)
}

const roundPosition = (position: Position): Position => [
  Number(position[0].toFixed(COORDINATE_DECIMALS)),
  Number(position[1].toFixed(COORDINATE_DECIMALS)),
]

const samePosition = (first: Position, second: Position) => first[0] === second[0] && first[1] === second[1]

const simplifyRing = (positions: Position[], tolerance: number): Position[] => {
  if (positions.length <= 4) return positions.map(roundPosition)
  const wasClosed = samePosition(positions[0], positions[positions.length - 1])
  const ring = (wasClosed ? positions.slice(0, -1) : positions).map(roundPosition)
  if (ring.length <= 3) return [...ring, ring[0]]

  // Split the closed ring at its farthest vertex to avoid simplifying identical endpoints as a zero-length line.
  const reference = ring[0]
  let farthestIndex = 1
  let farthestDistance = -1
  const averageLatitude = ring.reduce((sum, point) => sum + point[1], 0) / ring.length
  const longitudeScale = Math.cos((averageLatitude * Math.PI) / 180)
  for (let index = 1; index < ring.length; index++) {
    const dx = (ring[index][0] - reference[0]) * longitudeScale
    const dy = ring[index][1] - reference[1]
    const distance = dx * dx + dy * dy
    if (distance > farthestDistance) { farthestDistance = distance; farthestIndex = index }
  }

  const firstArc = simplifyOpenLine(ring.slice(0, farthestIndex + 1), tolerance, longitudeScale)
  const secondArc = simplifyOpenLine([...ring.slice(farthestIndex), reference], tolerance, longitudeScale)
  const simplified = [...firstArc, ...secondArc.slice(1, -1)]
  const distinct = simplified.filter((position, index) => index === 0 || !samePosition(position, simplified[index - 1]))
  if (distinct.length < 3) return [...ring.slice(0, 3), ring[0]]
  if (!samePosition(distinct[0], distinct[distinct.length - 1])) distinct.push(distinct[0])
  return distinct
}

const geometryTypeCode: Record<string, number> = { LineString: 1, MultiLineString: 2, Polygon: 3, MultiPolygon: 4 }
const geometryTypeFromCode = ['', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'] as const

const simplifyGeometry = (geometry: Geometry): PackedGeometry | undefined => {
  const code = geometryTypeCode[geometry.type]
  if (!code || !('coordinates' in geometry)) return undefined
  const simplifyLine = (positions: Position[]) => {
    const averageLatitude = positions.reduce((sum, position) => sum + position[1], 0) / Math.max(1, positions.length)
    return simplifyOpenLine(positions, SIMPLIFY_TOLERANCE_DEGREES, Math.cos((averageLatitude * Math.PI) / 180))
  }
  switch (geometry.type) {
    case 'LineString':
      return [code, simplifyLine(geometry.coordinates)]
    case 'MultiLineString':
      return [code, geometry.coordinates.map(simplifyLine)]
    case 'Polygon':
      return [code, geometry.coordinates.map((ring) => simplifyRing(ring, SIMPLIFY_TOLERANCE_DEGREES))]
    case 'MultiPolygon':
      return [code, geometry.coordinates.map((polygon) => polygon.map((ring) => simplifyRing(ring, SIMPLIFY_TOLERANCE_DEGREES)))]
    default:
      return undefined
  }
}

const packProject = (project: ShareProject): PackedProject => [
  2,
  project.name,
  project.continent,
  project.mapLayer,
  project.displayMode,
  project.features.map((feature) => [
    feature.name,
    feature.type,
    feature.lat,
    feature.lng,
    feature.geometry ? simplifyGeometry(feature.geometry) : undefined,
  ]),
]

const asProject = (value: unknown): ShareProject => {
  if (Array.isArray(value) && value[0] === 2 && Array.isArray(value[5])) {
    const packed = value as PackedProject
    return {
      id: crypto.randomUUID(),
      name: packed[1],
      continent: packed[2],
      mapLayer: packed[3],
      displayMode: packed[4],
      features: packed[5].map((feature) => {
        const code = feature[4]?.[0]
        const type = geometryTypeFromCode[code ?? 0]
        const geometry = code && type ? { type, coordinates: feature[4]?.[1] } as Geometry : undefined
        return { id: crypto.randomUUID(), name: feature[0], type: feature[1], lat: feature[2], lng: feature[3], geometry }
      }),
      testOrder: [],
      testIndex: 0,
      stats: { answered: 0, correct: 0, wrong: 0 },
    }
  }

  // Previously shared links carried the complete Project object. Keep importing them as before.
  const project = value as Partial<ShareProject> | null
  if (!project || typeof project !== 'object' || typeof project.name !== 'string' || !Array.isArray(project.features)) {
    throw new Error('Invalid shared project')
  }
  return {
    id: project.id || crypto.randomUUID(),
    name: project.name,
    continent: project.continent || 'europe',
    mapLayer: project.mapLayer === 'normal' ? 'normal' : 'blind',
    displayMode: project.displayMode === 'points' ? 'points' : 'shape',
    features: project.features.map((feature) => ({ ...feature, id: feature.id || crypto.randomUUID() })),
    testOrder: [],
    testIndex: 0,
    stats: { answered: 0, correct: 0, wrong: 0 },
  }
}

export const encodeSharedProject = (project: ShareProject) => `${SHARED_SCHEMA_PREFIX}${compress(JSON.stringify(packProject(project)))}`

export const decodeSharedProject = (token: string): ShareProject => {
  if (token.startsWith(SHARED_SCHEMA_PREFIX)) {
    const json = decompressFromBase64(fromBase64Url(token.slice(SHARED_SCHEMA_PREFIX.length)))
    if (!json) throw new Error('Shared project data is empty')
    return asProject(JSON.parse(json) as unknown)
  }
  if (token.startsWith(LEGACY_COMPRESSED_PREFIX)) {
    const json = decompressFromBase64(fromBase64Url(token.slice(LEGACY_COMPRESSED_PREFIX.length)))
    if (!json) throw new Error('Shared project data is empty')
    return asProject(JSON.parse(json) as unknown)
  }

  // Older browser-generated links used btoa(encodeURIComponent(JSON.stringify(project))).
  const normalized = token.replaceAll(' ', '+')
  try { return asProject(JSON.parse(fromBase64Url(normalized)) as unknown) }
  catch { return asProject(JSON.parse(decodeURIComponent(atob(normalized))) as unknown) }
}

export const sharedPayloadUrlLength = (project: ShareProject, baseUrl: string) => {
  const url = new URL(baseUrl)
  url.hash = `shared=${encodeSharedProject(project)}`
  return url.toString().length
}
