import { memo, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { CircleMarker, Polygon, Polyline, Tooltip } from 'react-leaflet'
import type { Geometry as GeoJsonGeometry, Position } from 'geojson'
import type { LeafletMouseEvent, LatLngExpression, PathOptions } from 'leaflet'
import { useMap } from 'react-leaflet'
import type { Feature, Project } from './projectModel'
import { getFeaturePresentation } from './featurePresentation'
import { MapRenderContext } from './MapRenderContext'
import { getCachedRenderGeometry, getFeatureLabelAnchor, getRenderZoomBucket } from './geometryRender'

type FeatureMapItemProps = {
  feature: Feature
  displayMode: Project['displayMode']
  mode: 'edit' | 'test'
  feedback: 'idle' | 'correct' | 'wrong' | 'far'
  targetId: string | undefined
  selectedId: string | null
  onSelect: (feature: Feature, event: LeafletMouseEvent) => void
}

const coordsToLatLng = (positions: Position[]): LatLngExpression[] => positions.map(([lng, lat]) => [lat, lng] as LatLngExpression)

type ConvertedGeometryPositions = LatLngExpression[] | LatLngExpression[][] | LatLngExpression[][][] | null

const geometryPositions = (geometry: GeoJsonGeometry | undefined): ConvertedGeometryPositions => {
  if (!geometry) return null
  switch (geometry.type) {
    case 'LineString': return coordsToLatLng(geometry.coordinates)
    case 'MultiLineString': return geometry.coordinates.map(coordsToLatLng)
    case 'Polygon': return geometry.coordinates.map(coordsToLatLng)
    case 'MultiPolygon': return geometry.coordinates.map((polygon) => polygon.map(coordsToLatLng))
    case 'Point':
    case 'MultiPoint':
    case 'GeometryCollection': return null
  }
}

function FeatureMapItemComponent({ feature, displayMode, mode, feedback, targetId, selectedId, onSelect }: FeatureMapItemProps) {
  const map = useMap()
  const renderContext = useContext(MapRenderContext)
  if (!renderContext) throw new Error('FeatureMapItem must be rendered inside MapRenderContext.')
  const { zoom, hoverRenderer } = renderContext
  const [hovered, setHovered] = useState(false)
  const presentation = getFeaturePresentation({ feature, displayMode, mode, feedback, targetId, selectedId, hovered })
  const labelAnchor = getFeatureLabelAnchor(feature, presentation.showShape && presentation.showTooltip)
  const zoomBucket = getRenderZoomBucket(zoom)
  const subscribeVisibility = useCallback((listener: () => void) => renderContext.viewportStore.subscribe(feature.id, feature.geometry, feature.lat, feature.lng, listener), [renderContext.viewportStore, feature.id, feature.geometry, feature.lat, feature.lng])
  const getVisibilitySnapshot = useCallback(() => renderContext.viewportStore.isFeatureVisible(feature.id, feature.geometry, feature.lat, feature.lng), [renderContext.viewportStore, feature.id, feature.geometry, feature.lat, feature.lng])
  const visible = useSyncExternalStore(subscribeVisibility, getVisibilitySnapshot, getVisibilitySnapshot)
  const renderGeometry = useMemo(() => visible && feature.geometry ? getCachedRenderGeometry(
    feature.geometry,
    (position) => map.project([position[1], position[0]], zoomBucket),
    zoomBucket,
  ) : undefined, [visible, feature.geometry, map, zoomBucket])
  const positions = useMemo(() => geometryPositions(renderGeometry), [renderGeometry])
  const center = useMemo<LatLngExpression>(() => [feature.lat, feature.lng], [feature.lat, feature.lng])
  const select = useCallback((event: LeafletMouseEvent) => onSelect(feature, event), [feature, onSelect])
  const hoverIn = useCallback(() => setHovered(true), [])
  const hoverOut = useCallback(() => setHovered(false), [])
  const eventHandlers = useMemo(() => ({ click: select, mouseover: hoverIn, mouseout: hoverOut }), [select, hoverIn, hoverOut])
  const pointOptions = useMemo(() => ({
    color: '#f7fbf4',
    weight: 3,
    fillColor: presentation.neutral ? '#174b43' : presentation.color,
    fillOpacity: 1,
  }), [presentation.neutral, presentation.color])
  const basePathColor = presentation.neutral ? '#75b7c1' : presentation.color
  const pathOptions = useMemo(() => ({ color: basePathColor, weight: 4, opacity: .9 }), [basePathColor])
  const polygonOptions = useMemo(() => ({ color: basePathColor, fillColor: presentation.fillColor, fillOpacity: .24, weight: 2 }), [basePathColor, presentation.fillColor])
  const hoverPathOptions = useMemo(() => ({ color: presentation.pathColor, weight: 5, opacity: .9 }), [presentation.pathColor])
  const hoverPolygonOptions = useMemo(() => ({ color: presentation.pathColor, fillColor: presentation.fillColor, fillOpacity: 0, weight: 3 }), [presentation.pathColor, presentation.fillColor])
  const staticPointRadius = presentation.pointRadius - (hovered ? 2 : 0)
  const hoverPointOptions = useMemo(() => ({ color: '#f7fbf4', weight: 3, fillColor: presentation.neutral ? '#174b43' : presentation.color, fillOpacity: 0 }), [presentation.neutral, presentation.color])

  if (!visible) return null

  const renderShape = (renderer: typeof hoverRenderer | undefined, lineStyle: PathOptions, polygonStyle: PathOptions, interactive: boolean) => {
    if (!feature.geometry || !positions) return null
    const geometry = renderGeometry
    if (!geometry) return null
    const common = { renderer, eventHandlers: interactive ? eventHandlers : undefined, interactive }
    if (geometry.type === 'LineString') return <Polyline positions={positions as LatLngExpression[]} pathOptions={lineStyle} {...common} />
    if (geometry.type === 'MultiLineString') return <>{(positions as LatLngExpression[][]).map((line, index) => <Polyline key={index} positions={line} pathOptions={lineStyle} {...common} />)}</>
    if (geometry.type === 'Polygon') return <Polygon positions={positions as LatLngExpression[][]} pathOptions={polygonStyle} {...common} />
    if (geometry.type === 'MultiPolygon') return <>{(positions as LatLngExpression[][][]).map((polygon, index) => <Polygon key={index} positions={polygon} pathOptions={polygonStyle} {...common} />)}</>
    return null
  }

  if (presentation.showShape && feature.geometry) return <>
    {renderShape(undefined, pathOptions, polygonOptions, true)}
    {hovered && renderShape(hoverRenderer, hoverPathOptions, hoverPolygonOptions, false)}
    {labelAnchor && <CircleMarker center={labelAnchor} radius={1} pathOptions={{ opacity: 0, fillOpacity: 0, weight: 0 }} interactive={false}>
      <Tooltip permanent>{feature.name}</Tooltip>
    </CircleMarker>}
  </>

  return <>
    <CircleMarker center={center} radius={staticPointRadius} pathOptions={pointOptions} eventHandlers={eventHandlers}>
      {presentation.showTooltip && <Tooltip direction="top" offset={[0, -7]} permanent>{feature.name}</Tooltip>}
    </CircleMarker>
    {hovered && <CircleMarker center={center} radius={staticPointRadius + 2} pathOptions={hoverPointOptions} renderer={hoverRenderer} interactive={false} />}
  </>
}

export const FeatureMapItem = memo(FeatureMapItemComponent)