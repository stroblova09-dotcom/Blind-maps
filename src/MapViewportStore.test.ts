import { describe, expect, it, vi } from 'vitest'
import { MapViewportStore } from './MapViewportStore'

describe('selective viewport culling subscriptions', () => {
  it('notifies only features whose viewport visibility changed after panning', () => {
    const store = new MapViewportStore({ south: 0, north: 10, west: 0, east: 20 })
    const visibleGeometry = { type: 'Polygon' as const, coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] }
    const stillVisibleGeometry = { type: 'Polygon' as const, coordinates: [[[15, 1], [16, 1], [16, 2], [15, 1]]] }
    const enteringGeometry = { type: 'Polygon' as const, coordinates: [[[21, 1], [22, 1], [22, 2], [21, 1]]] }
    const leaving = vi.fn()
    const staying = vi.fn()
    const entering = vi.fn()
    const unsubscribeLeaving = store.subscribe('leaving', visibleGeometry, 1, 1, leaving)
    const unsubscribeStaying = store.subscribe('staying', stillVisibleGeometry, 15, 1, staying)
    const unsubscribeEntering = store.subscribe('entering', enteringGeometry, 21, 1, entering)

    store.updateViewport({ south: 0, north: 10, west: 10, east: 30 })

    expect(leaving).toHaveBeenCalledTimes(1)
    expect(entering).toHaveBeenCalledTimes(1)
    expect(staying).not.toHaveBeenCalled()
    expect(store.isFeatureVisible('leaving', visibleGeometry, 1, 1)).toBe(false)
    expect(store.isFeatureVisible('entering', enteringGeometry, 21, 1)).toBe(true)

    unsubscribeLeaving()
    unsubscribeStaying()
    unsubscribeEntering()
  })
})