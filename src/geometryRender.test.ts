import { describe, expect, it } from 'vitest'
import type { Feature } from './projectModel'
import { countFeatureGeometryPositions, countGeometryPositions, getCachedRenderGeometry, getFeatureLabelAnchor, getGeometryRenderDiagnostics, getRenderZoomBucket, getRenderTolerance, geometryIntersectsViewport, resetGeometryRenderDiagnostics, simplifyGeometryForRender } from './geometryRender'

const circleRing = (count: number) => {
  const points = Array.from({ length: count }, (_, index) => {
    const angle = (index / (count - 1)) * Math.PI * 2
    const radius = 1 + Math.sin(index * 13) * .0001
    return [Math.cos(angle) * radius, Math.sin(angle) * radius]
  })
  points[points.length - 1] = points[0]
  return points
}

describe('lossless source geometry and derived map rendering', () => {
  it('simplifies only a derived low-zoom render geometry and keeps the original intact', () => {
    const positions = circleRing(4_000)
    const geometry = { type: 'Polygon' as const, coordinates: [positions] }
    const original = structuredClone(geometry)
    const project = (position: number[]) => ({ x: position[0] * 1000, y: position[1] * 1000 })
    const rendered = simplifyGeometryForRender(geometry, project, getRenderTolerance(3))

    expect(countGeometryPositions(rendered)).toBeLessThan(countGeometryPositions(geometry))
    expect(geometry).toEqual(original)
    expect(rendered.type).toBe('Polygon')
    if (rendered.type === 'Polygon') {
      expect(rendered.coordinates[0].length).toBeGreaterThanOrEqual(4)
      expect(rendered.coordinates[0][0]).toEqual(rendered.coordinates[0].at(-1))
    }
  })

  it('reduces screen-subpixel detail more at overview zoom and preserves high-zoom detail', () => {
    const line = Array.from({ length: 2_000 }, (_, index) => [index / 1000, Math.sin(index / 6) / 1000])
    const geometry = { type: 'LineString' as const, coordinates: line }
    const project = (position: number[]) => ({ x: position[0] * 2048, y: position[1] * 2048 })
    const overview = simplifyGeometryForRender(geometry, project, getRenderTolerance(3))
    const detailed = simplifyGeometryForRender(geometry, project, getRenderTolerance(18))

    expect(countGeometryPositions(overview)).toBeLessThan(countGeometryPositions(detailed))
    expect(countGeometryPositions(detailed)).toBeLessThanOrEqual(countGeometryPositions(geometry))
    expect(geometry.coordinates).toHaveLength(2_000)
  })

  it('counts original positions without dropping features from performance metrics', () => {
    const geometry: Feature['geometry'] = { type: 'Polygon', coordinates: [circleRing(112_049)] }
    expect(countFeatureGeometryPositions([geometry, undefined])).toBe(112_049)
  })

  it('reuses simplification for the same geometry and half-zoom bucket', () => {
    const geometry = { type: 'LineString' as const, coordinates: Array.from({ length: 500 }, (_, index) => [index / 1000, Math.sin(index) / 1000]) }
    resetGeometryRenderDiagnostics()
    const project = (position: number[]) => ({ x: position[0] * 1000, y: position[1] * 1000 })
    const first = getCachedRenderGeometry(geometry, project, 5)
    const cached = getCachedRenderGeometry(geometry, project, 5.1)
    const metrics = getGeometryRenderDiagnostics()

    expect(getRenderZoomBucket(5.1)).toBe(5)
    expect(cached).toBe(first)
    expect(metrics).toMatchObject({ computations: 1, cacheHits: 1, sourcePositions: 500 })
    expect(metrics.renderedPositions).toBeLessThan(500)
  })

  it('culls only source geometry whose bounds do not intersect the viewport', () => {
    const nearby = { type: 'Polygon' as const, coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] }
    const distant = { type: 'Polygon' as const, coordinates: [[[50, 50], [51, 50], [51, 51], [50, 50]]] }
    const viewport = { south: 0, north: 10, west: 0, east: 10 }
    expect(geometryIntersectsViewport(nearby, viewport)).toBe(true)
    expect(geometryIntersectsViewport(distant, viewport)).toBe(false)
  })

  it.each([
    { name: 'Polygon', geometry: { type: 'Polygon' as const, coordinates: [circleRing(4_000)] } },
    { name: 'MultiPolygon', geometry: { type: 'MultiPolygon' as const, coordinates: [[circleRing(100)], [circleRing(200)]] } },
    { name: 'complex MultiPolygon', geometry: { type: 'MultiPolygon' as const, coordinates: [[circleRing(112_049)], [circleRing(64)]] } },
  ])('returns only one stable reveal label anchor for $name', ({ geometry }) => {
    const feature = { id: 'shape', name: 'Shape', type: 'stát' as const, lat: 48, lng: 2, geometry }
    const anchors = [getFeatureLabelAnchor(feature, true)].filter((anchor) => anchor !== null)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toEqual([48, 2])
    expect(getFeatureLabelAnchor(feature, false)).toBeNull()
  })
})