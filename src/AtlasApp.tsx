import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, GeoJSON, MapContainer, Polygon, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { Check, ChevronDown, Compass, Crosshair, Expand, MapPin, Moon, Pencil, Plus, Search, Share2, Sparkles, Sun, Target, Trash2, X } from 'lucide-react'
import { compressToBase64, decompressFromBase64 } from 'lz-string'
import type { Geometry as GeoJsonGeometry, GeoJsonObject, Position } from 'geojson'
import type { LeafletMouseEvent, LatLng, LatLngBoundsExpression, LatLngExpression, LatLngLiteral, Map as LeafletMap } from 'leaflet'
import './App.css'
import './theme.css'

type Continent = 'europe' | 'asia' | 'africa' | 'americas' | 'oceania' | 'world'
type PlaceType = '' | 'město' | 'řeka' | 'jezero' | 'pohoří' | 'stát' | 'památka' | 'jiný objekt'
type Feature = { id: string; name: string; type: PlaceType; lat: number; lng: number; displayName?: string; geometry?: GeoJsonGeometry }
type Project = { id: string; name: string; continent: Continent; features: Feature[]; mapLayer: 'blind' | 'normal'; displayMode: 'shape' | 'points'; testOrder: string[]; testIndex: number; stats: { answered: number; correct: number; wrong: number } }
type SearchCandidate = { place_id: string; display_name: string; name: string; lat: string; lon: string; type?: string; class?: string; geojson?: GeoJsonGeometry }
type Store = { version: 2; projects: Project[]; activeProjectId: string }
type HitEvent = { latlng: LatLng; containerPoint: { x: number; y: number }; map: LeafletMap }

const STORE_KEY = 'atlas-memo-projects-v2'
const THEME_KEY = 'atlas-memo-theme'
const MAX_SHARE_URL_LENGTH = 12000
const configuredPublicUrl = import.meta.env.VITE_PUBLIC_APP_URL?.trim()
const continentData: Record<Continent, { label: string; short: string; center: LatLngLiteral; zoom: number; bounds: LatLngBoundsExpression }> = {
  europe: { label: 'Evropa', short: 'EU', center: { lat: 50.8, lng: 15.2 }, zoom: 4, bounds: [[34, -12], [72, 42]] },
  asia: { label: 'Asie', short: 'AS', center: { lat: 35, lng: 100 }, zoom: 3, bounds: [[0, 25], [78, 180]] },
  africa: { label: 'Afrika', short: 'AF', center: { lat: 5, lng: 20 }, zoom: 3, bounds: [[-37, -20], [38, 52]] },
  americas: { label: 'Amerika', short: 'AM', center: { lat: 10, lng: -75 }, zoom: 3, bounds: [[-57, -168], [72, -30]] },
  oceania: { label: 'Austrálie a Oceánie', short: 'OC', center: { lat: -24, lng: 145 }, zoom: 3.5, bounds: [[-50, 110], [10, 180]] },
  world: { label: 'Celý svět', short: '🌐', center: { lat: 18, lng: 15 }, zoom: 2, bounds: [[-60, -180], [80, 180]] },
}

const makeProject = (name: string, continent: Continent): Project => ({ id: crypto.randomUUID(), name, continent, features: [], mapLayer: 'blind', displayMode: 'shape', testOrder: [], testIndex: 0, stats: { answered: 0, correct: 0, wrong: 0 } })
const normalizeProject = (value: Partial<Project>): Project => ({
  ...value,
  id: value.id || crypto.randomUUID(),
  name: value.name || 'Mapa bez názvu',
  continent: value.continent && continentData[value.continent] ? value.continent : 'europe',
  features: Array.isArray(value.features) ? value.features : [],
  mapLayer: value.mapLayer === 'normal' ? 'normal' : 'blind',
  displayMode: value.displayMode === 'points' ? 'points' : 'shape',
  testOrder: Array.isArray(value.testOrder) ? value.testOrder : [],
  testIndex: Number.isInteger(value.testIndex) && (value.testIndex as number) >= 0 ? value.testIndex as number : 0,
  stats: { answered: value.stats?.answered ?? 0, correct: value.stats?.correct ?? 0, wrong: value.stats?.wrong ?? 0 },
})
const safeParse = (value: string | null): Store | null => {
  try {
    const parsed = value ? JSON.parse(value) as Partial<Store> : null
    if (parsed?.version !== 2 || !Array.isArray(parsed.projects)) return null
    const projects = parsed.projects.map((item) => normalizeProject(item))
    if (!projects.length) return null
    return { version: 2, projects, activeProjectId: projects.some((item) => item.id === parsed.activeProjectId) ? parsed.activeProjectId as string : projects[0]?.id ?? '' }
  } catch { return null }
}
const starterStore = (): Store => { const project = makeProject('Moje první mapa', 'europe'); return { version: 2, projects: [project], activeProjectId: project.id } }
const readTheme = () => { try { return localStorage.getItem(THEME_KEY) === 'dark' } catch { return false } }
const toBase64Url = (value: string) => {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const encodeShare = (project: Project) => `lz1_${toBase64Url(compressToBase64(JSON.stringify(project)))}`
const fromBase64Url = (value: string) => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
const decodeShare = (token: string): Project => {
  if (token.startsWith('lz1_')) {
    const compressed = fromBase64Url(token.slice(4))
    const json = decompressFromBase64(compressed)
    if (!json) throw new Error('Shared project data is empty')
    return JSON.parse(json) as Project
  }
  // Accept links from both previous share encodings, including raw base64 '+' characters.
  const normalized = token.replaceAll(' ', '+')
  try { return JSON.parse(fromBase64Url(normalized)) as Project }
  catch { return JSON.parse(decodeURIComponent(atob(normalized))) as Project }
}
const makeSharedCopy = (source: Project): Project => ({ ...normalizeProject(JSON.parse(JSON.stringify(source)) as Project), id: crypto.randomUUID(), name: `${source.name} – kopie`, stats: { answered: 0, correct: 0, wrong: 0 }, testIndex: 0, testOrder: [] })
const loadStore = (): Store => {
  let storedValue: string | null = null
  try { storedValue = localStorage.getItem(STORE_KEY) } catch { /* Continue with an in-memory project if storage is unavailable. */ }
  const saved = safeParse(storedValue)
  const sharedToken = window.location.hash.slice(1).split('&').map((part) => part.split('='))
    .find(([key]) => key === 'shared')?.[1]
  if (sharedToken) {
    try {
      const sharedProject = normalizeProject(decodeShare(decodeURIComponent(sharedToken)))
      const base = saved ?? starterStore()
      const copy = makeSharedCopy(sharedProject)
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
      return { ...base, projects: [...base.projects, copy], activeProjectId: copy.id }
    } catch { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`) }
  }
  if (saved) return saved
  const initial = starterStore()
  try {
    const legacyValue = localStorage.getItem('blind-maps-places')
    const legacy = JSON.parse(legacyValue ?? '[]') as Array<{ id?: string; name: string; type?: string; lat: number; lng: number; displayName?: string }>
    if (Array.isArray(legacy) && legacy.length) initial.projects[0].features = legacy.map((feature) => ({ ...feature, id: feature.id ?? crypto.randomUUID(), type: (feature.type ?? '') as PlaceType }))
  } catch { /* Ignore malformed legacy storage. */ }
  return initial
}

const coordsToLatLng = (positions: Position[]): LatLngExpression[] => positions.map(([lng, lat]) => [lat, lng] as LatLngExpression)
const mapPosition = (position: Position, map: LeafletMap) => map.latLngToContainerPoint([position[1], position[0]])
const segmentDistance = (point: { x: number; y: number }, start: { x: number; y: number }, end: { x: number; y: number }) => {
  const dx = end.x - start.x, dy = end.y - start.y
  const ratio = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy))
}
const lineDistance = (positions: Position[], point: { x: number; y: number }, map: LeafletMap) => {
  const projected = positions.map((position) => mapPosition(position, map))
  let nearest = Number.POSITIVE_INFINITY
  for (let index = 1; index < projected.length; index++) nearest = Math.min(nearest, segmentDistance(point, projected[index - 1], projected[index]))
  return nearest
}
const pointInRing = (point: LatLng, ring: Position[]) => {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index], [x2, y2] = ring[previous]
    if ((y1 > point.lat) !== (y2 > point.lat) && point.lng < ((x2 - x1) * (point.lat - y1)) / (y2 - y1) + x1) inside = !inside
  }
  return inside
}
const polygonContains = (point: LatLng, rings: Position[][]) => rings.length > 0 && pointInRing(point, rings[0]) && !rings.slice(1).some((ring) => pointInRing(point, ring))
const featureHitDistance = (feature: Feature, event: HitEvent) => {
  const point = event.containerPoint
  const pointDistance = Math.hypot(event.map.latLngToContainerPoint([feature.lat, feature.lng]).x - point.x, event.map.latLngToContainerPoint([feature.lat, feature.lng]).y - point.y)
  const geometry = feature.geometry
  if (!geometry || geometry.type === 'Point') return pointDistance <= 28 ? pointDistance : Number.POSITIVE_INFINITY
  if (geometry.type === 'LineString') {
    const distance = lineDistance(geometry.coordinates, point, event.map)
    return distance <= 14 ? distance : Number.POSITIVE_INFINITY
  }
  if (geometry.type === 'MultiLineString') {
    const distance = Math.min(...geometry.coordinates.map((line) => lineDistance(line, point, event.map)))
    return distance <= 14 ? distance : Number.POSITIVE_INFINITY
  }
  if (geometry.type === 'Polygon') {
    if (polygonContains(event.latlng, geometry.coordinates)) return 0
    const distance = Math.min(...geometry.coordinates.map((ring) => lineDistance(ring, point, event.map)))
    return distance <= 14 ? distance : Number.POSITIVE_INFINITY
  }
  if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) if (polygonContains(event.latlng, polygon)) return 0
    const distance = Math.min(...geometry.coordinates.flatMap((polygon) => polygon.map((ring) => lineDistance(ring, point, event.map))))
    return distance <= 14 ? distance : Number.POSITIVE_INFINITY
  }
  return pointDistance <= 28 ? pointDistance : Number.POSITIVE_INFINITY
}

function MapViewport({ children, resetView, viewKey, mapLayer, isFullscreen, onMapClick, onFullscreen }: { children: React.ReactNode; resetView: { center: LatLngLiteral; zoom: number }; viewKey: string; mapLayer: Project['mapLayer']; isFullscreen: boolean; onMapClick: (event: HitEvent) => void; onFullscreen: () => void }) {
  const map = useMap()
  const resetLat = resetView.center.lat
  const resetLng = resetView.center.lng
  const resetZoom = resetView.zoom
  useMapEvents({ click: (event) => onMapClick({ ...event, map }) })
  useEffect(() => {
    map.setView([resetLat, resetLng], resetZoom)
    const frame = requestAnimationFrame(() => map.invalidateSize())
    return () => cancelAnimationFrame(frame)
  }, [map, resetLat, resetLng, resetZoom, viewKey, mapLayer, isFullscreen])
  return <><div className="map-controls"><button onClick={() => map.zoomIn()} aria-label="Přiblížit">+</button><button onClick={() => map.zoomOut()} aria-label="Oddálit">−</button><button onClick={() => map.setView(resetView.center, resetView.zoom)} aria-label="Zobrazit celý kontinent"><Crosshair size={15} /></button><button onClick={onFullscreen} aria-label="Celá obrazovka"><Expand size={15} /></button></div>{children}</>
}

function GeometryLayer({ feature, color, fillColor, tooltip, permanentTooltip, onSelect, onHover }: { feature: Feature; color: string; fillColor: string; tooltip: boolean; permanentTooltip: boolean; onSelect: (event: LeafletMouseEvent) => void; onHover: (active: boolean) => void }) {
  const geometry = feature.geometry
  const handlers = { click: onSelect, mouseover: () => onHover(true), mouseout: () => onHover(false) }
  if (!geometry || geometry.type === 'Point') return null
  if (geometry.type === 'LineString') return <Polyline positions={coordsToLatLng(geometry.coordinates)} pathOptions={{ color, weight: 4, opacity: .9 }} eventHandlers={handlers}>{tooltip && <Tooltip sticky permanent={permanentTooltip}>{feature.name}</Tooltip>}</Polyline>
  if (geometry.type === 'MultiLineString') return <>{geometry.coordinates.map((line, index) => <Polyline key={index} positions={coordsToLatLng(line)} pathOptions={{ color, weight: 4, opacity: .9 }} eventHandlers={handlers}>{tooltip && <Tooltip sticky permanent={permanentTooltip}>{feature.name}</Tooltip>}</Polyline>)}</>
  if (geometry.type === 'Polygon') return <Polygon positions={geometry.coordinates.map(coordsToLatLng)} pathOptions={{ color, fillColor, fillOpacity: .24, weight: 2 }} eventHandlers={handlers}>{tooltip && <Tooltip sticky permanent={permanentTooltip}>{feature.name}</Tooltip>}</Polygon>
  if (geometry.type === 'MultiPolygon') return <>{geometry.coordinates.map((polygon, index) => <Polygon key={index} positions={polygon.map(coordsToLatLng)} pathOptions={{ color, fillColor, fillOpacity: .24, weight: 2 }} eventHandlers={handlers}>{tooltip && <Tooltip sticky permanent={permanentTooltip}>{feature.name}</Tooltip>}</Polygon>)}</>
  return null
}

function App() {
  const [store, setStore] = useState<Store>(loadStore)
  const [mode, setMode] = useState<'edit' | 'test'>('edit')
  const [query, setQuery] = useState('')
  const [placeType, setPlaceType] = useState<PlaceType>('')
  const [candidates, setCandidates] = useState<SearchCandidate[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [notice, setNotice] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<'idle' | 'correct' | 'wrong' | 'far'>('idle')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [boundaryData, setBoundaryData] = useState<GeoJsonObject | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectContinent, setNewProjectContinent] = useState<Continent>('europe')
  const [darkMode, setDarkMode] = useState(readTheme)
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | 'error'>('saving')
  const project = store.projects.find((item) => item.id === store.activeProjectId) ?? store.projects[0]
  const continent = continentData[project.continent]
  const target = project.features.find((feature) => feature.id === project.testOrder[project.testIndex])
  const stats = useMemo(() => ({ ...project.stats, total: project.features.length, success: project.stats.answered ? Math.round((project.stats.correct / project.stats.answered) * 100) : 0 }), [project.features.length, project.stats])

  useEffect(() => {
    let result: 'saved' | 'error' = 'saved'
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)) }
    catch { result = 'error' }
    const timer = window.setTimeout(() => setSaveStatus(result), 0)
    return () => window.clearTimeout(timer)
  }, [store])
  useEffect(() => { try { localStorage.setItem(THEME_KEY, darkMode ? 'dark' : 'light') } catch { /* Theme preference is optional. */ } }, [darkMode])
  useEffect(() => {
    const controller = new AbortController()
    fetch('https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson', { signal: controller.signal }).then((response) => response.ok ? response.json() as Promise<GeoJsonObject> : null).then(setBoundaryData).catch(() => setBoundaryData(null))
    return () => controller.abort()
  }, [])

  const updateProject = (updater: (current: Project) => Project) => setStore((current) => ({ ...current, projects: current.projects.map((item) => item.id === project.id ? updater(item) : item) }))
  const selectProject = (id: string) => { setStore((current) => ({ ...current, activeProjectId: id })); setMode('edit'); setFeedback('idle'); setSelectedId(null); setHoveredId(null); setCandidates([]); setNotice('') }
  const createProject = () => { const next = makeProject(newProjectName.trim() || 'Nová mapa', newProjectContinent); setStore((current) => ({ ...current, projects: [...current.projects, next], activeProjectId: next.id })); setNewProjectName(''); setShowCreate(false); setMode('edit'); setNotice('Nový projekt byl vytvořen.') }
  const renameProject = () => { const name = window.prompt('Nový název projektu:', project.name)?.trim(); if (name) updateProject((current) => ({ ...current, name })) }
  const deleteProject = () => {
    if (!window.confirm(`Opravdu smazat projekt „${project.name}“?`)) return
    setStore((current) => { const remaining = current.projects.filter((item) => item.id !== project.id); const fallback = remaining[0] ?? makeProject('Moje první mapa', 'europe'); return { ...current, projects: remaining.length ? remaining : [fallback], activeProjectId: remaining[0]?.id ?? fallback.id } })
    setMode('edit'); setFeedback('idle'); setSelectedId(null)
  }
  const shareProject = async () => {
    try {
      const shareUrl = new URL(configuredPublicUrl || window.location.href)
      shareUrl.hash = `shared=${encodeShare(project)}`
      const url = shareUrl.toString()
      if (url.length > MAX_SHARE_URL_LENGTH) { setNotice('Projekt je příliš velký pro bezpečné sdílení v odkazu. Zmenši počet nebo geometrii objektů a zkus to znovu.'); return }
      const localAddress = ['localhost', '127.0.0.1', '::1'].includes(shareUrl.hostname)
      const localWarning = localAddress ? ' Pozor: adresa localhost funguje pouze na tomto počítači. Pro sdílení na jiné zařízení aplikaci nasaď na veřejnou HTTPS adresu; můžeš ji nastavit jako VITE_PUBLIC_APP_URL.' : ''
      try { await navigator.clipboard.writeText(url); setNotice(`Odkaz na nezávislou kopii byl zkopírován.${localWarning}`) }
      catch { window.prompt('Zkopíruj odkaz na nezávislou kopii:', url); setNotice(`Odkaz připraven ke zkopírování.${localWarning}`) }
    } catch { setNotice('Odkaz se nepodařilo vytvořit.') }
  }

  const searchPlaces = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!query.trim()) return
    setIsSearching(true); setCandidates([]); setNotice('')
    const querySuffix: Partial<Record<PlaceType, string>> = { řeka: ' river', jezero: ' lake', pohoří: ' mountain range', stát: ' country' }
    try {
      const searchQuery = `${query.trim()}${querySuffix[placeType] ?? ''}`
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&extratags=1&limit=10&accept-language=cs&q=${encodeURIComponent(searchQuery)}`)
      if (!response.ok) throw new Error('Search failed')
      const result = await response.json() as SearchCandidate[]
      const category: Partial<Record<PlaceType, string[]>> = { řeka: ['river', 'stream', 'waterway'], jezero: ['lake', 'reservoir', 'water'], pohoří: ['mountain_range', 'mountain'], stát: ['administrative', 'country'] }
      const prioritized = [...result].sort((a, b) => {
        const rank = (candidate: SearchCandidate) => (candidate.geojson && candidate.geojson.type !== 'Point' ? 2 : 0) + (category[placeType]?.some((value) => `${candidate.type} ${candidate.class}`.toLowerCase().includes(value)) ? 4 : 0)
        return rank(b) - rank(a)
      })
      setCandidates(prioritized.slice(0, 7))
      if (!result.length) setNotice('Místo se nepodařilo najít. Zkus upřesnit název.')
    } catch { setNotice('Vyhledávání se nepodařilo dokončit. Zkontroluj připojení.') }
    finally { setIsSearching(false) }
  }
  const addCandidate = (candidate: SearchCandidate) => {
    const name = candidate.name || candidate.display_name.split(',')[0]
    const duplicate = project.features.some((feature) => feature.name.toLocaleLowerCase() === name.toLocaleLowerCase() || (Math.abs(feature.lat - Number(candidate.lat)) < .0001 && Math.abs(feature.lng - Number(candidate.lon)) < .0001))
    if (duplicate) { setNotice('Tento pojem už v projektu existuje.'); return }
    const geometry = candidate.geojson && candidate.geojson.type !== 'Point' ? candidate.geojson : undefined
    const feature: Feature = { id: crypto.randomUUID(), name, type: placeType, lat: Number(candidate.lat), lng: Number(candidate.lon), displayName: candidate.display_name, geometry }
    updateProject((current) => ({ ...current, features: [...current.features, feature] })); setCandidates([]); setQuery(''); setNotice(geometry ? 'Místo i jeho geometrie byly přidány.' : 'Místo bylo přidáno jako bod; geometrie nebyla dostupná.')
  }
  const editFeature = (feature: Feature) => { const name = window.prompt('Název pojmu:', feature.name)?.trim(); if (!name || name === feature.name) return; updateProject((current) => ({ ...current, features: current.features.map((item) => item.id === feature.id ? { ...item, name } : item) })) }
  const removeFeature = (id: string) => updateProject((current) => ({ ...current, features: current.features.filter((feature) => feature.id !== id), testOrder: current.testOrder.filter((item) => item !== id), testIndex: 0 }))
  const clearFeatures = () => { if (window.confirm('Opravdu vymazat všechny pojmy v tomto projektu?')) updateProject((current) => ({ ...current, features: [], testOrder: [], testIndex: 0 })) }
  const startTest = () => { if (!project.features.length) { setNotice('Nejdřív přidej alespoň jeden pojem.'); return } const order = [...project.features].sort(() => Math.random() - .5).map((feature) => feature.id); updateProject((current) => ({ ...current, testOrder: order, testIndex: 0, stats: { answered: 0, correct: 0, wrong: 0 } })); setMode('test'); setFeedback('idle'); setSelectedId(null); setHoveredId(null) }
  const nextQuestion = () => { updateProject((current) => ({ ...current, testIndex: current.testIndex + 1 })); setFeedback('idle'); setSelectedId(null); setHoveredId(null) }
  const evaluateFeature = (feature: Feature) => {
    if (mode !== 'test' || (feedback !== 'idle' && feedback !== 'far') || !target) return
    setSelectedId(feature.id)
    const correct = feature.id === target.id
    setFeedback(correct ? 'correct' : 'wrong')
    updateProject((current) => ({ ...current, stats: { answered: current.stats.answered + 1, correct: current.stats.correct + (correct ? 1 : 0), wrong: current.stats.wrong + (correct ? 0 : 1) } }))
  }
  const selectFeature = (feature: Feature, event: LeafletMouseEvent) => {
    event.originalEvent.stopPropagation()
    if (mode === 'edit') setSelectedId(feature.id)
    else evaluateFeature(feature)
  }
  const answer = (event: HitEvent) => {
    if (mode !== 'test' || (feedback !== 'idle' && feedback !== 'far') || !target) return
    const nearest = project.features.map((feature) => ({ feature, distance: featureHitDistance(feature, event) })).sort((a, b) => a.distance - b.distance)[0]
    if (!nearest || !Number.isFinite(nearest.distance)) { setFeedback('far'); return }
    evaluateFeature(nearest.feature)
  }
  const handleFullscreen = () => setIsFullscreen((value) => !value)
  const handleLayer = (layer: Project['mapLayer']) => updateProject((current) => ({ ...current, mapLayer: layer }))
  const handleDisplayMode = (displayMode: Project['displayMode']) => updateProject((current) => ({ ...current, displayMode }))
  const labelVisible = (feature: Feature) => mode === 'edit' || (mode === 'test' && (feedback === 'correct' || feedback === 'wrong') && (feature.id === target?.id || feature.id === selectedId))

  return <main className={`app-shell ${darkMode ? 'dark-theme' : ''}`}>
    <header className="topbar"><div className="brand"><span className="brand-mark"><Compass size={18} /></span><span>atlas<span className="brand-accent">.</span>memo</span></div><div className="topbar-meta"><span className={`status-dot ${saveStatus === 'error' ? 'status-error' : ''}`} />{saveStatus === 'saving' ? 'Ukládám…' : saveStatus === 'error' ? 'Nepodařilo se uložit' : 'Uloženo'}<button className="avatar" aria-label="Profil uživatele">M</button></div></header>
    <div className="workspace">
      <aside className="sidebar"><div className="sidebar-heading"><div><span className="eyebrow">MŮJ ATLAS</span><h1>Moje projekty</h1></div><button className="icon-button" onClick={() => setShowCreate(true)} aria-label="Nový projekt"><Plus size={18} /></button></div><div className="section-label">PROJEKTY</div><nav className="project-list">{store.projects.map((item) => <button key={item.id} className={`project-item ${item.id === project.id ? 'active' : ''}`} onClick={() => selectProject(item.id)}><span className="project-marker">{continentData[item.continent].short}</span><span className="project-name"><strong>{item.name}</strong><small>{continentData[item.continent].label} · {item.features.length} {item.features.length === 1 ? 'pojem' : 'pojmy'}</small></span>{item.id === project.id && <ChevronDown size={16} />}</button>)}</nav><div className="sidebar-note"><Sparkles size={16} /><div><strong>Uč se podle sebe</strong><span>Každý projekt má vlastní mapu a statistiky.</span></div></div><div className="sidebar-footer"><button className="theme-toggle" onClick={() => setDarkMode((value) => !value)}>{darkMode ? <Sun size={15} /> : <Moon size={15} />}{darkMode ? 'Světlý režim' : 'Tmavý režim'}</button><span className="saved-icon"><Check size={14} /></span><span>Automaticky ukládáme<br /><strong>v prohlížeči</strong></span></div></aside>
      <section className={`main-panel ${isFullscreen ? 'fullscreen-panel' : ''}`}><div className="content-header"><div><span className="eyebrow">PRACOVNÍ PROSTOR / {continent.label.toUpperCase()}</span><h2>{mode === 'edit' ? project.name : 'Najdi správné místo'}</h2><p>{mode === 'edit' ? 'Vytvoř si vlastní sbírku míst k procvičení.' : 'Klikni přímo na bod nebo objekt, který odpovídá zadání.'}</p></div><div className="header-actions"><button className="subtle-button" onClick={renameProject}><Pencil size={14} /> Přejmenovat</button><button className="subtle-button" onClick={shareProject}><Share2 size={14} /> Sdílet</button><button className="mode-button" onClick={deleteProject} aria-label="Smazat projekt"><Trash2 size={14} /></button><button className={`mode-button ${mode === 'edit' ? 'selected' : ''}`} onClick={() => { setMode('edit'); setFeedback('idle'); setSelectedId(null) }}><Pencil size={15} /> Upravit mapu</button><button className={`mode-button test ${mode === 'test' ? 'selected' : ''}`} onClick={startTest}><Target size={15} /> Testovat</button></div></div>
        {mode === 'test' && target && <div className={`quiz-banner ${feedback}`}><div className="quiz-label"><Target size={17} /><span>AKTUÁLNÍ ÚKOL</span></div><strong>Najdi: {target.name}</strong>{feedback === 'idle' && <span className="quiz-help">Objekty nemají popisky, dokud neodpovíš.</span>}{feedback === 'far' && <span className="feedback-text">Klikni na jeden z objektů na mapě.</span>}{feedback === 'correct' && <span className="feedback-text"><Check size={16} /> Správně!</span>}{feedback === 'wrong' && <span className="feedback-text">Špatně. Klikla jsi na „{project.features.find((feature) => feature.id === selectedId)?.name}“.</span>}{feedback !== 'idle' && feedback !== 'far' && <button onClick={nextQuestion} className="next-button">{project.testIndex + 1 >= project.testOrder.length ? 'Zobrazit shrnutí' : 'Další otázka'} <span>→</span></button>}</div>}
        {mode === 'test' && !target && <div className="quiz-banner complete"><strong>Test dokončen</strong><span>{stats.correct} / {stats.answered} správně · úspěšnost {stats.success} %</span><button onClick={startTest} className="next-button">Testovat znovu →</button></div>}
        <div className={`map-card ${isFullscreen ? 'map-card-fullscreen' : ''}`}><MapContainer key={project.id} center={continent.center} zoom={continent.zoom} minZoom={2} scrollWheelZoom zoomControl={false} className="map"><MapViewport onMapClick={answer} onFullscreen={handleFullscreen} resetView={{ center: continent.center, zoom: continent.zoom }} viewKey={project.id} mapLayer={project.mapLayer} isFullscreen={isFullscreen}>{project.mapLayer === 'normal' && <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />}{project.mapLayer === 'blind' && boundaryData && <GeoJSON data={boundaryData} interactive={false} style={{ color: '#8ca69b', weight: 1, fillColor: '#dfece4', fillOpacity: 0 }} />}
          <div className="map-layer-control" role="group" aria-label="Podklad mapy"><button className={project.mapLayer === 'blind' ? 'active' : ''} onClick={() => handleLayer('blind')}>Slepá mapa</button><button className={project.mapLayer === 'normal' ? 'active' : ''} onClick={() => handleLayer('normal')}>Normální mapa</button></div>
          {project.features.map((feature) => {
            const showShape = project.displayMode === 'shape' && feature.geometry && feature.geometry.type !== 'Point'
            const isTarget = mode === 'test' && feature.id === target?.id
            const isSelected = feature.id === selectedId
            const neutral = mode === 'test' && feedback === 'idle'
            const revealed = mode === 'test' && (feedback === 'correct' || feedback === 'wrong') && (isTarget || isSelected)
            const hovered = hoveredId === feature.id
            const color = neutral ? '#174b43' : isTarget ? '#3d8c70' : isSelected ? '#d85b45' : '#174b43'
            const pathColor = neutral ? (hovered ? '#438b91' : '#75b7c1') : (hovered ? '#ed6a3a' : color)
            const showTooltip = labelVisible(feature)
            const permanentTooltip = mode === 'test' && revealed
            const handlers = { click: (event: LeafletMouseEvent) => selectFeature(feature, event), mouseover: () => setHoveredId(feature.id), mouseout: () => setHoveredId((current) => current === feature.id ? null : current) }
            return <span key={feature.id} className="feature-layer">
              {showShape ? <GeometryLayer feature={feature} color={pathColor} fillColor={neutral ? '#a9d6d9' : color} tooltip={showTooltip} permanentTooltip={permanentTooltip} onSelect={(event) => selectFeature(feature, event)} onHover={(active) => setHoveredId(active ? feature.id : null)} /> : <CircleMarker center={[feature.lat, feature.lng]} radius={(revealed ? 9 : 7) + (hovered ? 2 : 0)} pathOptions={{ color: '#f7fbf4', weight: 3, fillColor: neutral ? '#174b43' : color, fillOpacity: 1 }} eventHandlers={handlers}>{showTooltip && <Tooltip direction="top" offset={[0, -7]} permanent={permanentTooltip}>{feature.name}</Tooltip>}</CircleMarker>}
            </span>
          })}
        </MapViewport></MapContainer><div className="map-overlay"><span><span className="legend-dot" /> {project.features.length} {project.features.length === 1 ? 'pojem' : 'pojmy'} na mapě</span><span className="map-source"><MapPin size={13} />{project.mapLayer === 'blind' ? 'Hranice: Natural Earth' : '© OpenStreetMap contributors'}</span></div></div>
        <div className="display-mode-control" role="group" aria-label="Zobrazení objektů"><span>Zobrazení objektů</span><button className={project.displayMode === 'shape' ? 'active' : ''} onClick={() => handleDisplayMode('shape')}>Tvar</button><button className={project.displayMode === 'points' ? 'active' : ''} onClick={() => handleDisplayMode('points')}>Body</button></div>
        {mode === 'edit' ? <div className="editor-grid"><div className="add-panel"><div className="panel-title"><span className="number-badge">01</span><div><h3>Přidej místo</h3><p>Vyhledej skutečné místo a vyber správný výsledek.</p></div></div><form onSubmit={searchPlaces} className="search-form"><div className="search-input"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Vyhledat místo..." /><button type="button" aria-label="Vymazat hledání" onClick={() => { setQuery(''); setCandidates([]) }}><X size={15} /></button></div><div className="select-wrap"><select value={placeType} onChange={(event) => setPlaceType(event.target.value as PlaceType)}><option value="">Typ – volitelné</option><option>město</option><option>řeka</option><option>jezero</option><option>pohoří</option><option>stát</option><option>památka</option><option>jiný objekt</option></select><ChevronDown size={15} /></div><button className="add-button" disabled={isSearching}>{isSearching ? 'Hledám...' : <><Search size={16} /> Vyhledat</>}</button></form>{candidates.length > 0 && <div className="candidate-list">{candidates.map((candidate) => <button key={candidate.place_id} onClick={() => addCandidate(candidate)}><MapPin size={15} /><span><strong>{candidate.name || candidate.display_name.split(',')[0]}</strong><small>{candidate.display_name}</small></span><Plus size={15} /></button>)}</div>}{notice && <p className={`notice ${notice.includes('nepodařilo') || notice.includes('existuje') || notice.includes('příliš velký') ? 'error' : ''}`}>{notice}</p>}<p className="data-note"><Crosshair size={14} /> Hranice z dat Natural Earth · objekty ukládají dostupnou geometrii.</p></div><div className="places-panel"><div className="list-heading"><div><span className="section-label">TVOJE POJMY</span><strong>{project.features.length} {project.features.length === 1 ? 'položka' : 'položek'}</strong></div><button onClick={clearFeatures} className="clear-button">Vymazat vše</button></div><div className="place-list">{project.features.length === 0 ? <div className="empty-state">Projekt je zatím prázdný.<br />Vyhledej první místo výše.</div> : project.features.map((feature, index) => <div className={`place-row ${selectedId === feature.id ? 'selected-row' : ''}`} key={feature.id} onClick={() => setSelectedId(feature.id)}><span className="row-index">{String(index + 1).padStart(2, '0')}</span><span className="place-pin"><MapPin size={14} /></span><div className="place-copy"><strong>{feature.name}</strong><span>{feature.type || 'bez typu'} · {feature.lat.toFixed(2)}°, {feature.lng.toFixed(2)}°{feature.geometry ? ' · geometrie' : ''}</span></div><button className="edit-button" aria-label={`Upravit ${feature.name}`} onClick={(event) => { event.stopPropagation(); editFeature(feature) }}><Pencil size={14} /></button><button className="delete-button" aria-label={`Odstranit ${feature.name}`} onClick={(event) => { event.stopPropagation(); removeFeature(feature.id) }}><Trash2 size={15} /></button></div>)}</div></div></div> : <div className="stats-panel"><div><span className="section-label">STATISTIKY PROJEKTU</span><strong>{stats.total} pojmů</strong></div><div><strong>{stats.answered}</strong><span>zodpovězeno</span></div><div><strong>{stats.correct}</strong><span>správně</span></div><div><strong>{stats.wrong}</strong><span>špatně</span></div><div><strong>{stats.success} %</strong><span>úspěšnost</span></div></div>}
      </section>
    </div>
    {showCreate && <div className="modal-backdrop" onClick={() => setShowCreate(false)}><div className="modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">NOVÝ PROJEKT</span><h3>Vytvoř vlastní mapu</h3></div><button className="icon-button" onClick={() => setShowCreate(false)}><X size={16} /></button></div><label>Název projektu<input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Např. Řeky Evropy" /></label><label>Kontinent<select value={newProjectContinent} onChange={(event) => setNewProjectContinent(event.target.value as Continent)}>{(Object.keys(continentData) as Continent[]).map((key) => <option key={key} value={key}>{continentData[key].label}</option>)}</select></label><button className="add-button modal-submit" onClick={createProject}><Plus size={16} /> Vytvořit projekt</button></div></div>}
  </main>
}

export default App