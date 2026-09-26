import { memo, useCallback, useMemo } from 'react'
import { CircleMarker, Polygon, Polyline, Tooltip } from 'react-leaflet'
import type { Geometry as GeoJsonGeometry, Position } from 'geojson'
import type { LeafletMouseEvent, LatLngExpression } from 'leaflet'
import type { Feature, Project } from './projectModel'
import { getFeaturePresentation } from './featurePresentation'

type FeatureMapItemProps = {
  feature: Feature
  displayMode: Project['displayMode']
  mode: 'edit' | 'test'
  feedback: 'idle' | 'correct' | 'wrong' | 'far'
  targetId: string | undefined
  selectedId: string | null
  hovered: boolean
  onSelect: (feature: Feature, event: LeafletMouseEvent) => void
  onHover: (featureId: string, active: boolean) => void
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

function FeatureMapItemComponent({ feature, displayMode, mode, feedback, targetId, selectedId, hovered, onSelect, onHover }: FeatureMapItemProps) {
  const presentation = getFeaturePresentation({ feature, displayMode, mode, feedback, targetId, selectedId, hovered })
  const positions = useMemo(() => geometryPositions(feature.geometry), [feature.geometry])
  const center = useMemo<LatLngExpression>(() => [feature.lat, feature.lng], [feature.lat, feature.lng])
  const select = useCallback((event: LeafletMouseEvent) => onSelect(feature, event), [feature, onSelect])
  const hoverIn = useCallback(() => onHover(feature.id, true), [feature.id, onHover])
  const hoverOut = useCallback(() => onHover(feature.id, false), [feature.id, onHover])
  const eventHandlers = useMemo(() => ({ click: select, mouseover: hoverIn, mouseout: hoverOut }), [select, hoverIn, hoverOut])
  const pointOptions = useMemo(() => ({
    color: '#f7fbf4',
    weight: 3,
    fillColor: presentation.neutral ? '#174b43' : presentation.color,
    fillOpacity: 1,
  }), [presentation.neutral, presentation.color])
  const pathOptions = useMemo(() => ({ color: presentation.pathColor, weight: 4, opacity: .9 }), [presentation.pathColor])
  const polygonOptions = useMemo(() => ({ color: presentation.pathColor, fillColor: presentation.fillColor, fillOpacity: .24, weight: 2 }), [presentation.pathColor, presentation.fillColor])

  if (presentation.showShape && feature.geometry && !positions) return null
  if (presentation.showShape && feature.geometry && positions) {
    const geometry = feature.geometry
    const tooltip = presentation.showTooltip && <Tooltip sticky permanent={presentation.permanentTooltip}>{feature.name}</Tooltip>
    if (geometry.type === 'LineString') return <Polyline positions={positions as LatLngExpression[]} pathOptions={pathOptions} eventHandlers={eventHandlers}>{tooltip}</Polyline>
    if (geometry.type === 'MultiLineString') return <>{(positions as LatLngExpression[][]).map((line, index) => <Polyline key={index} positions={line} pathOptions={pathOptions} eventHandlers={eventHandlers}>{presentation.showTooltip && <Tooltip sticky permanent={presentation.permanentTooltip}>{feature.name}</Tooltip>}</Polyline>)}</>
    if (geometry.type === 'Polygon') return <Polygon positions={positions as LatLngExpression[][]} pathOptions={polygonOptions} eventHandlers={eventHandlers}>{tooltip}</Polygon>
    if (geometry.type === 'MultiPolygon') return <>{(positions as LatLngExpression[][][]).map((polygon, index) => <Polygon key={index} positions={polygon} pathOptions={polygonOptions} eventHandlers={eventHandlers}>{presentation.showTooltip && <Tooltip sticky permanent={presentation.permanentTooltip}>{feature.name}</Tooltip>}</Polygon>)}</>
  }

  return <CircleMarker center={center} radius={presentation.pointRadius} pathOptions={pointOptions} eventHandlers={eventHandlers}>
    {presentation.showTooltip && <Tooltip direction="top" offset={[0, -7]} permanent={presentation.permanentTooltip}>{feature.name}</Tooltip>}
  </CircleMarker>
}

export const FeatureMapItem = memo(FeatureMapItemComponent)