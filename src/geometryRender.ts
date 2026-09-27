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

export const countGeometryPositions = (geometry: Geometry | undefined): number => {
  if (!geometry) return 0
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

export const countFeatureGeometryPositions = (geometries: Array<Geometry | undefined>) => geometries.reduce((total, geometry) => total + countGeometryPositions(geometry), 0)