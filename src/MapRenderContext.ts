import { createContext } from 'react'
import type { SVG } from 'leaflet'

export type MapRenderContextValue = { zoom: number; hoverRenderer: SVG }

export const MapRenderContext = createContext<MapRenderContextValue | null>(null)