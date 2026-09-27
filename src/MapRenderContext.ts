import { createContext } from 'react'
import type { SVG } from 'leaflet'
import type { MapViewportStore } from './MapViewportStore'

export type MapRenderContextValue = { zoom: number; hoverRenderer: SVG; viewportStore: MapViewportStore }

export const MapRenderContext = createContext<MapRenderContextValue | null>(null)