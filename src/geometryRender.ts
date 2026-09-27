import type { Geometry, Position } from 'geojson'

type ProjectedPoint = { x: number; y: number }
type ProjectPosition = (position: Position) => ProjectedPoint

const squaredDistanceToSegment = (point: ProjectedPoint, start: ProjectedPoint, end: ProjectedPoint) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
  const x = start.x + ratio * dx
  const y = start.y + ratio * dy
  return (point.x - x) ** 2 + (point.y - y) ** 2
}

const simplifyOpenPath = (positions: Position[], projected: ProjectedPoint[], toleranceSquared: number) => {
  if (positions.length <= 2) return positions
  const keep = new Uint8Array(positions.length)
  keep[0] = 1
  keep[positions.length - 1] = 1
  const stack: Array<[number, number]> = [[0, positions.length - 1]]
  while (stack.length) {
    const [startIndex, endIndex] = stack.pop()!
    let farthestIndex = -1
    let farthestDistance = toleranceSquared
    for (let index = startIndex + 1; index < endIndex; index++) {
      const distance = squaredDistanceToSegment(projected[index], projected[startIndex], projected[endIndex])
      if (distance > farthestDistance) {
        farthestDistance = distance
        farthestIndex = index
      }
    }
    if (farthestIndex !== -1) {
      keep[farthestIndex] = 1
      stack.push([startIndex, farthestIndex], [farthestIndex, endIndex])
    }
  }
  return positions.filter((_, index) => keep[index] === 1)
}

const simplifyPath = (positions: Position[], project: ProjectPosition, tolerance: number, closed: boolean): Position[] => {
  if (positions.length <= (closed ? 4 : 2) || tolerance <= 0) return positions
  const projected = positions.map(project)
  const toleranceSquared = tolerance * tolerance
  if (!closed) return simplifyOpenPath(positions, projected, toleranceSquared)

  const uniqueEnd = positions.length - 1
  let farthestIndex = 1
  let farthestDistance = -1
  for (let index = 1; index < uniqueEnd; index++) {
    const point = projected[index]
    const distance = (point.x - projected[0].x) ** 2 + (point.y - projected[0].y) ** 2
    if (distance > farthestDistance) {
      farthestDistance = distance
      farthestIndex = index
    }
  }
  const firstArc = simplifyOpenPath(positions.slice(0, farthestIndex + 1), projected.slice(0, farthestIndex + 1), toleranceSquared)
  const secondArc = simplifyOpenPath(positions.slice(farthestIndex, positions.length), projected.slice(farthestIndex), toleranceSquared)
  const simplified = [...firstArc, ...secondArc.slice(1)]
  return simplified.length >= 4 ? simplified : positions
}

export const getRenderTolerance = (zoom: number) => Math.max(.35, Math.min(1.5, 1.5 - zoom * .065))

export const getRenderZoomBucket = (zoom: number) => Math.round(zoom * 2) / 2

const renderGeometryCache = new WeakMap<Geometry, Map<number, Geometry>>()
const geometryBoundsCache = new WeakMap<Geometry, GeometryBounds>()
const geometryPositionCountCache = new WeakMap<Geometry, number>()
const MAX_CACHED_ZOOM_BUCKETS_PER_GEOMETRY = 8
let geometryRenderStats = { computations: 0, cacheHits: 0, sourcePositions: 0, renderedPositions: 0, computeMilliseconds: 0 }

export type GeometryRenderDiagnostics = typeof geometryRenderStats

export const getGeometryRenderDiagnostics = (): GeometryRenderDiagnostics => ({ ...geometryRenderStats })
export const resetGeometryRenderDiagnostics = () => { geometryRenderStats = { computations: 0, cacheHits: 0, sourcePositions: 0, renderedPositions: 0, computeMilliseconds: 0 } }

export const getCachedRenderGeometry = (geometry: Geometry, project: ProjectPosition, zoom: number): Geometry => {
  const bucket = getRenderZoomBucket(zoom)
  let geometryCache = renderGeometryCache.get(geometry)
  const cached = geometryCache?.get(bucket)
  if (cached) {
    geometryRenderStats.cacheHits++
    return cached
  }
  const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now()
  const rendered = simplifyGeometryForRender(geometry, project, getRenderTolerance(bucket))
  const finishedAt = typeof performance === 'undefined' ? Date.now() : performance.now()
  geometryRenderStats.computations++
  geometryRenderStats.sourcePositions += countGeometryPositions(geometry)
  geometryRenderStats.renderedPositions += countGeometryPositions(rendered)
  geometryRenderStats.computeMilliseconds += finishedAt - startedAt
  if (!geometryCache) {
    geometryCache = new Map()
    renderGeometryCache.set(geometry, geometryCache)
  }
  geometryCache.set(bucket, rendered)
  if (geometryCache.size > MAX_CACHED_ZOOM_BUCKETS_PER_GEOMETRY) {
    const oldestBucket = geometryCache.keys().next().value
    if (oldestBucket !== undefined) geometryCache.delete(oldestBucket)
  }
  return rendered
}

export type GeometryBounds = { south: number; north: number; west: number; east: number }
export type GeographicViewport = GeometryBounds

const extendBounds = (bounds: GeometryBounds, position: Position) => {
  bounds.south = Math.min(bounds.south, position[1])
  bounds.north = Math.max(bounds.north, position[1])
  bounds.west = Math.min(bounds.west, position[0])
  bounds.east = Math.max(bounds.east, position[0])
}

const extendGeometryBounds = (geometry: Geometry, bounds: GeometryBounds) => {
  switch (geometry.type) {
    case 'Point': extendBounds(bounds, geometry.coordinates); break
    case 'MultiPoint':
    case 'LineString': geometry.coordinates.forEach((position) => extendBounds(bounds, position)); break
    case 'MultiLineString':
    case 'Polygon': geometry.coordinates.forEach((line) => line.forEach((position) => extendBounds(bounds, position))); break
    case 'MultiPolygon': geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => ring.forEach((position) => extendBounds(bounds, position)))); break
    case 'GeometryCollection': geometry.geometries.forEach((child) => extendGeometryBounds(child, bounds)); break
  }
}

export const getGeometryBounds = (geometry: Geometry): GeometryBounds => {
  const cached = geometryBoundsCache.get(geometry)
  if (cached) return cached
  const bounds = { south: Number.POSITIVE_INFINITY, north: Number.NEGATIVE_INFINITY, west: Number.POSITIVE_INFINITY, east: Number.NEGATIVE_INFINITY }
  extendGeometryBounds(geometry, bounds)
  geometryBoundsCache.set(geometry, bounds)
  return bounds
}

const longitudeIntervalsOverlap = (geometryWest: number, geometryEast: number, viewportWest: number, viewportEast: number) => {
  for (const offset of [-720, -360, 0, 360, 720]) {
    if (geometryEast + offset >= viewportWest && geometryWest + offset <= viewportEast) return true
  }
  return false
}

export const geometryIntersectsViewport = (geometry: Geometry, viewport: GeographicViewport) => {
  const bounds = getGeometryBounds(geometry)
  return bounds.north >= viewport.south
    && bounds.south <= viewport.north
    && longitudeIntervalsOverlap(bounds.west, bounds.east, viewport.west, viewport.east)
}

export const positionIsInViewport = (latitude: number, longitude: number, viewport: GeographicViewport) => latitude >= viewport.south
  && latitude <= viewport.north
  && longitudeIntervalsOverlap(longitude, longitude, viewport.west, viewport.east)

export const getFeatureLabelAnchor = (feature: { lat: number; lng: number; geometry?: Geometry }, showLabel: boolean): [number, number] | null => showLabel && feature.geometry && feature.geometry.type !== 'Point'
  ? [feature.lat, feature.lng]
  : null

export const simplifyGeometryForRender = (geometry: Geometry, project: ProjectPosition, tolerance: number): Geometry => {
  switch (geometry.type) {
    case 'LineString': return { ...geometry, coordinates: simplifyPath(geometry.coordinates, project, tolerance, false) }
    case 'MultiLineString': return { ...geometry, coordinates: geometry.coordinates.map((line) => simplifyPath(line, project, tolerance, false)) }
    case 'Polygon': return { ...geometry, coordinates: geometry.coordinates.map((ring) => simplifyPath(ring, project, tolerance, true)) }
    case 'MultiPolygon': return { ...geometry, coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => simplifyPath(ring, project, tolerance, true))) }
    case 'Point':
    case 'MultiPoint':
    case 'GeometryCollection': return geometry
  }
}

const countGeometryPositionsUncached = (geometry: Geometry): number => {
  switch (geometry.type) {
    case 'Point': return 1
    case 'MultiPoint':
    case 'LineString': return geometry.coordinates.length
    case 'MultiLineString':
    case 'Polygon': return geometry.coordinates.reduce((total, line) => total + line.length, 0)
    case 'MultiPolygon': return geometry.coordinates.reduce((total, polygon) => total + polygon.reduce((polygonTotal, ring) => polygonTotal + ring.length, 0), 0)
    case 'GeometryCollection': return geometry.geometries.reduce((total, child) => total + countGeometryPositions(child), 0)
  }
}

export const countGeometryPositions = (geometry: Geometry | undefined): number => {
  if (!geometry) return 0
  const cached = geometryPositionCountCache.get(geometry)
  if (cached !== undefined) return cached
  const count = countGeometryPositionsUncached(geometry)
  geometryPositionCountCache.set(geometry, count)
  return count
}

export const countFeatureGeometryPositions = (geometries: Array<Geometry | undefined>) => geometries.reduce((total, geometry) => total + countGeometryPositions(geometry), 0)