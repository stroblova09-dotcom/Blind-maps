import { geometryIntersectsViewport, positionIsInViewport } from './geometryRender'
import type { GeographicViewport } from './geometryRender'
import type { Geometry } from 'geojson'

type VisibilitySubscription = { geometry: Geometry | undefined; latitude: number; longitude: number; visible: boolean; listeners: Set<() => void> }

const isVisible = (geometry: Geometry | undefined, latitude: number, longitude: number, viewport: GeographicViewport) => geometry
  ? geometryIntersectsViewport(geometry, viewport) || positionIsInViewport(latitude, longitude, viewport)
  : positionIsInViewport(latitude, longitude, viewport)

export class MapViewportStore {
  private viewport: GeographicViewport
  private readonly subscriptions = new Map<string, VisibilitySubscription>()

  constructor(viewport: GeographicViewport) {
    this.viewport = viewport
  }

  subscribe(featureId: string, geometry: Geometry | undefined, latitude: number, longitude: number, listener: () => void) {
    let entry = this.subscriptions.get(featureId)
    if (!entry) {
      entry = { geometry, latitude, longitude, visible: isVisible(geometry, latitude, longitude, this.viewport), listeners: new Set() }
      this.subscriptions.set(featureId, entry)
    } else {
      entry.geometry = geometry
      entry.latitude = latitude
      entry.longitude = longitude
      entry.visible = isVisible(geometry, latitude, longitude, this.viewport)
    }
    entry.listeners.add(listener)
    return () => {
      const current = this.subscriptions.get(featureId)
      current?.listeners.delete(listener)
      if (current?.listeners.size === 0) this.subscriptions.delete(featureId)
    }
  }

  isFeatureVisible(featureId: string, geometry: Geometry | undefined, latitude: number, longitude: number) {
    const entry = this.subscriptions.get(featureId)
    if (entry && entry.geometry === geometry && entry.latitude === latitude && entry.longitude === longitude) return entry.visible
    return isVisible(geometry, latitude, longitude, this.viewport)
  }

  updateViewport(viewport: GeographicViewport) {
    if (this.viewport.south === viewport.south
      && this.viewport.north === viewport.north
      && this.viewport.west === viewport.west
      && this.viewport.east === viewport.east) return
    this.viewport = viewport
    for (const entry of this.subscriptions.values()) {
      const visible = isVisible(entry.geometry, entry.latitude, entry.longitude, viewport)
      if (visible === entry.visible) continue
      entry.visible = visible
      entry.listeners.forEach((listener) => listener())
    }
  }
}
