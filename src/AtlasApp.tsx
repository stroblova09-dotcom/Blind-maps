import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GeoJSON, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { Check, ChevronDown, Compass, Crosshair, Expand, MapPin, Moon, Pencil, Plus, Search, Share2, Sparkles, Sun, Target, Trash2, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import type { Geometry as GeoJsonGeometry, GeoJsonObject, Position } from 'geojson'
import { svg } from 'leaflet'
import type { LeafletMouseEvent, LatLng, LatLngBoundsExpression, LatLngLiteral, Map as LeafletMap } from 'leaflet'
import { isFirebaseConfigured } from './lib/firebaseConfig'
import { normalizeProject, parseProjectStore, STORE_KEY } from './projectModel'
import { backupLocalStore, measureLocalProjects, migrateLocalProjects, ProjectImportError, FirestoreWriteError } from './projectRepository'
import type { CloudProject, ProjectRepository } from './projectRepository'
import type { Continent, Feature, PlaceType, Project, Store } from './projectModel'
import { FeatureMapItem } from './FeatureMapItem'
import { ProjectPlaceRow } from './ProjectPlaceRow'
import { MapRenderContext } from './MapRenderContext'
import { countFeatureGeometryPositions } from './geometryRender'
import { FullscreenTestContext } from './FullscreenTestContext'
import { getQuizContext } from './testProgress'
import { decodeSharedProject, encodeSharedProject, SHARE_URL_LIMIT } from './shareCodec'
import './App.css'
import './theme.css'

type SearchCandidate = { place_id: string; display_name: string; name?: string; namedetails?: Record<string, string>; localizedName?: string; lat: string; lon: string; type?: string; class?: string; geojson?: GeoJsonGeometry }
type HitEvent = { latlng: LatLng; containerPoint: { x: number; y: number }; map: LeafletMap }
type AuthStatus = 'checking' | 'signed-out' | 'signing-in' | 'signing-out' | 'signed-in' | 'unconfigured' | 'error'
type SyncConflict = { id: string; cloud: CloudProject | null }
type FirebaseAuthModule = typeof import('./lib/firebase')

const THEME_KEY = 'atlas-memo-theme'
const configuredPublicUrl = import.meta.env.VITE_PUBLIC_APP_URL?.trim()
const formatByteSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
const describeImportError = (error: unknown) => {
  if (error instanceof ProjectImportError) {
    if (error.stage === 'local backup') return `Zálohu se nepodařilo vytvořit ještě před přístupem k Firestore. Původní localStorage nebyl změněn. ${error.message}`
    if (error.stage === 'Firestore read') return `Záloha je zachována, ale načtení seznamu z Firestore selhalo. ${error.message}`
    if (error.cause instanceof FirestoreWriteError) {
      const write = error.cause
      const diagnostic = `Dávka ${write.batchIndex}: ${write.documentCount} mutations, odhad ${formatByteSize(write.estimatedBytes)}; dokumenty: ${write.documentIds.join(', ')}.`
      if (write.code.includes('resource-exhausted')) return `Firestore odmítl zápis kvůli serverové kvótě při operaci „${write.stage}“ projektu „${error.projectName}“ (kód ${write.code}). ${diagnostic} Záloha i localStorage jsou zachovány.`
      if (write.code.includes('permission-denied')) return `Firestore Rules odmítla operaci „${write.stage}“ pro projekt „${error.projectName}“ (kód ${write.code}). ${diagnostic} Záloha i localStorage jsou zachovány.`
      return `Zápis do Firestore selhal ve fázi „${write.stage}“ projektu „${error.projectName}“ (${write.documentCount} dokumentových změn, kód ${write.code}). Záloha i localStorage jsou zachovány. ${write.message}`
    }
    return `Zápis projektu „${error.projectName}“ do Firestore selhal. Záloha i localStorage jsou zachovány. ${error.message}`
  }
  return error instanceof Error ? error.message : 'Nepodařenou operaci se nepodařilo blíže určit.'
}
const localizedSearchAliases: Record<string, { query: string; name: string }> = {
  'floridský záliv': { query: 'Florida Bay', name: 'Floridský záliv' },
}
const continentData: Record<Continent, { label: string; short: string; center: LatLngLiteral; zoom: number; bounds: LatLngBoundsExpression }> = {
  europe: { label: 'Evropa', short: 'EU', center: { lat: 50.8, lng: 15.2 }, zoom: 4, bounds: [[34, -12], [72, 42]] },
  asia: { label: 'Asie', short: 'AS', center: { lat: 35, lng: 100 }, zoom: 3, bounds: [[0, 25], [78, 180]] },
  africa: { label: 'Afrika', short: 'AF', center: { lat: 5, lng: 20 }, zoom: 3, bounds: [[-37, -20], [38, 52]] },
  americas: { label: 'Amerika', short: 'AM', center: { lat: 10, lng: -75 }, zoom: 3, bounds: [[-57, -168], [72, -30]] },
  oceania: { label: 'Austrálie a Oceánie', short: 'OC', center: { lat: -24, lng: 145 }, zoom: 3.5, bounds: [[-50, 110], [10, 180]] },
  world: { label: 'Celý svět', short: '🌐', center: { lat: 18, lng: 15 }, zoom: 2, bounds: [[-60, -180], [80, 180]] },
}

const makeProject = (name: string, continent: Continent): Project => ({ id: crypto.randomUUID(), name, continent, features: [], mapLayer: 'blind', displayMode: 'shape', testOrder: [], testIndex: 0, stats: { answered: 0, correct: 0, wrong: 0 } })
const starterStore = (): Store => { const project = makeProject('Moje první mapa', 'europe'); return { version: 2, projects: [project], activeProjectId: project.id } }
const readTheme = () => { try { return localStorage.getItem(THEME_KEY) === 'dark' } catch { return false } }
const makeSharedCopy = (source: Project): Project => ({ ...normalizeProject(JSON.parse(JSON.stringify(source)) as Project), id: crypto.randomUUID(), name: `${source.name} – kopie`, stats: { answered: 0, correct: 0, wrong: 0 }, testIndex: 0, testOrder: [] })
const getCandidateName = (candidate: SearchCandidate) => candidate.localizedName
  || candidate.namedetails?.['name:cs']
  || candidate.namedetails?.['loc_name:cs']
  || candidate.namedetails?.['official_name:cs']
  || candidate.namedetails?.['short_name:cs']
  || candidate.display_name.split(',')[0]
  || candidate.namedetails?.['name:en']
  || candidate.name
  || ''
const searchCandidates = async (term: string, type: PlaceType, signal?: AbortSignal) => {
  const trimmedTerm = term.trim()
  const alias = localizedSearchAliases[trimmedTerm.toLocaleLowerCase('cs-CZ')]
  const querySuffix: Partial<Record<PlaceType, string>> = { řeka: ' river', jezero: ' lake', pohoří: ' mountain range', stát: ' country' }
  const searchTerm = alias?.query ?? `${trimmedTerm}${querySuffix[type] ?? ''}`
  const params = new URLSearchParams({ format: 'jsonv2', polygon_geojson: '1', namedetails: '1', extratags: '1', limit: '10', 'accept-language': 'cs,en', q: searchTerm })
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal })
  if (!response.ok) throw new Error('Search failed')
  const results = await response.json() as SearchCandidate[]
  const category: Partial<Record<PlaceType, string[]>> = { řeka: ['river', 'stream', 'waterway'], jezero: ['lake', 'reservoir', 'water'], pohoří: ['mountain_range', 'mountain'], stát: ['administrative', 'country'] }
  return results
    .map((candidate) => alias ? { ...candidate, localizedName: alias.name } : candidate)
    .sort((a, b) => {
      const rank = (candidate: SearchCandidate) => (candidate.geojson && candidate.geojson.type !== 'Point' ? 2 : 0) + (category[type]?.some((value) => `${candidate.type} ${candidate.class}`.toLowerCase().includes(value)) ? 4 : 0)
      return rank(b) - rank(a)
    })
    .slice(0, 7)
}
const loadStore = (): Store => {
  let storedValue: string | null = null
  try { storedValue = localStorage.getItem(STORE_KEY) } catch { /* Continue with an in-memory project if storage is unavailable. */ }
  const saved = parseProjectStore(storedValue)
  const sharedToken = window.location.hash.slice(1).split('&').map((part) => part.split('='))
    .find(([key]) => key === 'shared')?.[1]
  if (sharedToken) {
    try {
      const sharedProject = normalizeProject(decodeSharedProject(decodeURIComponent(sharedToken)) as unknown as Partial<Project>)
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
  const [zoom, setZoom] = useState(resetZoom)
  const hoverRenderer = useMemo(() => svg(), [])
  const renderContext = useMemo(() => ({ zoom, hoverRenderer }), [zoom, hoverRenderer])
  useMapEvents({
    click: (event) => onMapClick({ ...event, map }),
    zoomend: () => setZoom(map.getZoom()),
  })
  useEffect(() => {
    map.setView([resetLat, resetLng], resetZoom)
  }, [map, resetLat, resetLng, resetZoom, viewKey, mapLayer])
  useEffect(() => {
    const frame = requestAnimationFrame(() => map.invalidateSize())
    return () => cancelAnimationFrame(frame)
  }, [map, isFullscreen])
  return <><div className="map-controls"><button onClick={() => map.zoomIn()} aria-label="Přiblížit">+</button><button onClick={() => map.zoomOut()} aria-label="Oddálit">−</button><button onClick={() => map.setView(resetView.center, resetView.zoom)} aria-label="Zobrazit celý kontinent"><Crosshair size={15} /></button><button onClick={onFullscreen} aria-label="Celá obrazovka"><Expand size={15} /></button></div><MapRenderContext.Provider value={renderContext}>{children}</MapRenderContext.Provider></>
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
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatus>(isFirebaseConfigured ? 'checking' : 'unconfigured')
  const [authError, setAuthError] = useState('')
  const [syncStatus, setSyncStatus] = useState<'signed-out' | 'loading' | 'choice' | 'ready' | 'syncing' | 'error'>('signed-out')
  const [syncPrompt, setSyncPrompt] = useState<'import' | 'choose' | null>(null)
  const [syncError, setSyncError] = useState('')
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([])
  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([])
  const [hasLocalData, setHasLocalData] = useState(false)
  const [localMeasurement, setLocalMeasurement] = useState<ReturnType<typeof measureLocalProjects> | null>(null)
  const [syncTick, setSyncTick] = useState(0)
  const [cloudReady, setCloudReady] = useState(false)
  const searchRequestId = useRef(0)
  const storeRef = useRef(store)
  const cloudReadyRef = useRef(false)
  const cloudBaselineRef = useRef(new Map<string, CloudProject>())
  const conflictsRef = useRef(new Set<string>())
  const savesInFlightRef = useRef(new Set<string>())
  const localRawStoreRef = useRef<string | null>(null)
  const repositoryRef = useRef<ProjectRepository | null>(null)
  const firebaseAuthRef = useRef<FirebaseAuthModule | null>(null)
  const project = store.projects.find((item) => item.id === store.activeProjectId) ?? store.projects[0]
  const continent = continentData[project.continent]
  const quizContext = useMemo(() => getQuizContext(project, project.testIndex, feedback), [project, feedback])
  const target = quizContext.target
  const stats = useMemo(() => ({ ...project.stats, total: project.features.length, success: project.stats.answered ? Math.round((project.stats.correct / project.stats.answered) * 100) : 0 }), [project.features.length, project.stats])
  const geometryMetrics = useMemo(() => project.features.reduce((metrics, feature) => {
    const count = countFeatureGeometryPositions([feature.geometry])
    return { totalPositions: metrics.totalPositions + count, featuresWithGeometry: metrics.featuresWithGeometry + Number(count > 0), largestFeaturePositions: Math.max(metrics.largestFeaturePositions, count) }
  }, { totalPositions: 0, featuresWithGeometry: 0, largestFeaturePositions: 0 }), [project.features])

  useEffect(() => {
    let result: 'saved' | 'error' = 'saved'
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)) }
    catch { result = 'error' }
    const timer = window.setTimeout(() => setSaveStatus(result), 0)
    return () => window.clearTimeout(timer)
  }, [store])
  useEffect(() => { storeRef.current = store }, [store])
  useEffect(() => {
    if (import.meta.env.DEV) console.info('[Map performance] Source geometry metrics', { featureCount: project.features.length, ...geometryMetrics })
  }, [project.features.length, geometryMetrics])
  useEffect(() => {
    const retryPendingSync = () => setSyncTick((value) => value + 1)
    window.addEventListener('online', retryPendingSync)
    return () => window.removeEventListener('online', retryPendingSync)
  }, [])
  useEffect(() => { try { localStorage.setItem(THEME_KEY, darkMode ? 'dark' : 'light') } catch { /* Theme preference is optional. */ } }, [darkMode])
  useEffect(() => {
    if (!isFirebaseConfigured) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    import('./lib/firebase').then((firebase) => {
      if (cancelled) return
      firebaseAuthRef.current = firebase
      unsubscribe = firebase.observeFirebaseUser((user) => {
        console.info('[Project sync] Auth state changed', { uid: user?.uid ?? null })
        setFirebaseUser(user)
        setAuthStatus(user ? 'signed-in' : 'signed-out')
        setAuthError('')
      }, (error) => {
        console.error('[Firebase Auth] Auth state listener failed', { message: error.message })
        setFirebaseUser(null)
        setAuthStatus('error')
        setAuthError(`Stav přihlášení se nepodařilo ověřit: ${error.message}`)
      })
    }).catch((error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : String(error)
      console.error('[Firebase Auth] Firebase Auth module failed to load', { message })
      setAuthStatus('error')
      setAuthError(`Firebase přihlášení se nepodařilo načíst: ${message}`)
    })
    return () => { cancelled = true; unsubscribe?.(); firebaseAuthRef.current = null }
  }, [])
  useEffect(() => {
    if (!firebaseUser) {
      cloudReadyRef.current = false
      cloudBaselineRef.current.clear()
      conflictsRef.current.clear()
      return
    }
    let cancelled = false
    let initialized = false
    let unsubscribe: (() => void) | undefined
    cloudReadyRef.current = false
    cloudBaselineRef.current.clear()
    conflictsRef.current.clear()
    try { localRawStoreRef.current = localStorage.getItem(STORE_KEY) } catch { localRawStoreRef.current = null }
    const savedLocalStore = parseProjectStore(localRawStoreRef.current)
    queueMicrotask(() => {
      if (cancelled) return
      setCloudReady(false)
      setSyncStatus('loading')
      setSyncPrompt(null)
      setSyncError('')
      setSyncConflicts([])
      setHasLocalData(Boolean(savedLocalStore))
      setLocalMeasurement(savedLocalStore ? measureLocalProjects(localRawStoreRef.current ?? '', savedLocalStore.projects) : null)
    })
    import('./lib/firebaseProjectStore').then(({ projectRepository }) => {
      if (cancelled) return
      repositoryRef.current = projectRepository
      console.info('[Project sync] Starting project listener', { uid: firebaseUser.uid })
      unsubscribe = projectRepository.watchProjects(firebaseUser.uid, (remoteProjects) => {
        if (cancelled) return
        console.info('[Project sync] Project listener received snapshot', { uid: firebaseUser.uid, count: remoteProjects.length, projectIds: remoteProjects.map(({ project: remoteProject }) => remoteProject.id) })
        const next = new Map(remoteProjects.map((item) => [item.project.id, item]))
        setCloudProjects(remoteProjects)
        if (!initialized) {
          initialized = true
          cloudBaselineRef.current = next
          if (remoteProjects.length) {
            console.info('[Project sync] Initial cloud projects require an explicit local/cloud choice', { uid: firebaseUser.uid, localProjectCount: savedLocalStore?.projects.length ?? 0, cloudProjectCount: remoteProjects.length })
            setSyncPrompt('choose')
            setSyncStatus('choice')
          } else if (savedLocalStore) {
            console.info('[Project sync] Cloud is empty; local projects require explicit import', { uid: firebaseUser.uid, localProjectCount: savedLocalStore.projects.length })
            setSyncPrompt('import')
            setSyncStatus('choice')
          } else {
            cloudReadyRef.current = true
            setCloudReady(true)
            setSyncStatus('ready')
          }
          return
        }
        if (!cloudReadyRef.current) {
          cloudBaselineRef.current = next
          if (!remoteProjects.length) {
            setSyncPrompt(savedLocalStore ? 'import' : null)
            setSyncStatus(savedLocalStore ? 'choice' : 'ready')
            if (!savedLocalStore) { cloudReadyRef.current = true; setCloudReady(true) }
          }
          return
        }

        const currentStore = storeRef.current
        for (const remote of remoteProjects) {
          const previous = cloudBaselineRef.current.get(remote.project.id)
          const local = currentStore.projects.find((item) => item.id === remote.project.id)
          if (conflictsRef.current.has(remote.project.id)) continue
          if (!previous) {
            if (!local) setStore((current) => ({ ...current, projects: [...current.projects, remote.project] }))
          } else if ((remote.revision !== previous.revision || remote.changeId !== previous.changeId) && JSON.stringify(local) !== JSON.stringify(remote.project)) {
            const localHasChanges = Boolean(local && JSON.stringify(local) !== JSON.stringify(previous.project))
            if (localHasChanges) {
              conflictsRef.current.add(remote.project.id)
              setSyncConflicts((current) => current.some((item) => item.id === remote.project.id) ? current.map((item) => item.id === remote.project.id ? { id: remote.project.id, cloud: remote } : item) : [...current, { id: remote.project.id, cloud: remote }])
            } else if (local) {
              setStore((current) => ({ ...current, projects: current.projects.map((item) => item.id === remote.project.id ? remote.project : item) }))
            }
          }
        }
        for (const [id, previous] of cloudBaselineRef.current) {
          if (next.has(id) || conflictsRef.current.has(id)) continue
          const local = currentStore.projects.find((item) => item.id === id)
          if (local && JSON.stringify(local) !== JSON.stringify(previous.project)) {
            conflictsRef.current.add(id)
            setSyncConflicts((current) => current.some((item) => item.id === id) ? current.map((item) => item.id === id ? { id, cloud: null } : item) : [...current, { id, cloud: null }])
          } else if (local) {
            setStore((current) => ({ ...current, projects: current.projects.filter((item) => item.id !== id) }))
          }
        }
        cloudBaselineRef.current = next
        setSyncStatus((current) => current === 'syncing' ? current : 'ready')
      }, (error) => {
        if (cancelled) return
        console.error('[Project sync] Project listener failed', { uid: firebaseUser.uid, code: 'code' in error ? error.code : 'unknown' })
        setSyncError(error.message)
        setSyncStatus('error')
      })
    }).catch((error: unknown) => {
      if (cancelled) return
      setSyncError(error instanceof Error ? error.message : 'Firestore se nepodařilo načíst.')
      setSyncStatus('error')
    })
    return () => { cancelled = true; unsubscribe?.() }
  }, [firebaseUser])
  useEffect(() => {
    if (!firebaseUser || !cloudReady || !repositoryRef.current) return
    const repository = repositoryRef.current
    const uid = firebaseUser.uid
    let hasPending = false
    for (const projectToSave of store.projects) {
      const id = projectToSave.id
      if (conflictsRef.current.has(id) || savesInFlightRef.current.has(id)) continue
      const cloud = cloudBaselineRef.current.get(id)
      if (cloud && JSON.stringify(cloud.project) === JSON.stringify(projectToSave)) continue
      hasPending = true
      savesInFlightRef.current.add(id)
      let savedSuccessfully = false
      console.info('[Project sync] Saving project', { uid, projectId: id, expectedRevision: cloud?.revision ?? 0 })
      setSyncStatus('syncing')
      repository.saveProject(uid, projectToSave, cloud?.revision ?? 0).then((saved) => {
        savedSuccessfully = true
        console.info('[Project sync] Project saved', { uid, projectId: id, revision: saved.revision })
        cloudBaselineRef.current.set(id, saved)
        setSyncError('')
      }).catch((error: unknown) => {
        console.error('[Project sync] Project save failed', { uid, projectId: id, code: error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.name : 'unknown' })
        if (error instanceof Error && error.name === 'ProjectRevisionConflictError') {
          repository.listProjects(uid).then((latest) => {
            const newer = latest.find((item) => item.project.id === id)
            if (newer) {
              cloudBaselineRef.current.set(id, newer)
              conflictsRef.current.add(id)
              setSyncConflicts((current) => current.some((item) => item.id === id) ? current.map((item) => item.id === id ? { id, cloud: newer } : item) : [...current, { id, cloud: newer }])
            } else {
              conflictsRef.current.add(id)
              setSyncConflicts((current) => current.some((item) => item.id === id) ? current.map((item) => item.id === id ? { id, cloud: null } : item) : [...current, { id, cloud: null }])
            }
          }).catch((loadError: unknown) => {
            setSyncError(loadError instanceof Error ? loadError.message : 'Cloudovou verzi se nepodařilo načíst.')
            setSyncStatus('error')
          })
        } else {
          setSyncError(error instanceof Error ? error.message : 'Projekt se nepodařilo synchronizovat.')
          setSyncStatus('error')
        }
      }).finally(() => {
        savesInFlightRef.current.delete(id)
        if (savedSuccessfully) setSyncTick((value) => value + 1)
      })
    }
    for (const [id, cloud] of cloudBaselineRef.current) {
      if (store.projects.some((item) => item.id === id) || conflictsRef.current.has(id) || savesInFlightRef.current.has(id)) continue
      hasPending = true
      savesInFlightRef.current.add(id)
      let deletedSuccessfully = false
      setSyncStatus('syncing')
      repository.deleteProject(uid, id).then(() => { deletedSuccessfully = true; cloudBaselineRef.current.delete(id) }).catch((error: unknown) => {
        setSyncError(error instanceof Error ? error.message : 'Projekt se nepodařilo smazat z cloudu.')
        setSyncStatus('error')
      }).finally(() => {
        savesInFlightRef.current.delete(id)
        if (deletedSuccessfully) setSyncTick((value) => value + 1)
      })
      void cloud
    }
    if (!hasPending) setSyncStatus((current) => current === 'error' ? current : 'ready')
  }, [firebaseUser, cloudReady, store.projects, syncTick])
  useEffect(() => {
    const controller = new AbortController()
    fetch('https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson', { signal: controller.signal }).then((response) => response.ok ? response.json() as Promise<GeoJsonObject> : null).then(setBoundaryData).catch(() => setBoundaryData(null))
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const term = query.trim()
    if (mode !== 'edit' || term.length < 2) return
    const requestId = ++searchRequestId.current
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setIsSearching(true)
      setNotice('')
      searchCandidates(term, placeType, controller.signal).then((results) => {
        if (searchRequestId.current !== requestId) return
        setCandidates(results)
        if (!results.length) setNotice('Místo se nepodařilo najít. Zkus upřesnit název.')
      }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (searchRequestId.current === requestId) setNotice('Vyhledávání se nepodařilo dokončit. Zkontroluj připojení.')
      }).finally(() => {
        if (searchRequestId.current === requestId) setIsSearching(false)
      })
    }, 800)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, placeType, mode])

  const updateProject = useCallback((updater: (current: Project) => Project) => setStore((current) => ({ ...current, projects: current.projects.map((item) => item.id === project.id ? updater(item) : item) })), [project.id])
  const setFeatureHovered = useCallback((featureId: string, active: boolean) => setHoveredId((current) => active ? featureId : current === featureId ? null : current), [])
  const selectPlaceRow = useCallback((id: string) => setSelectedId(id), [])
  const selectProject = (id: string) => { setStore((current) => ({ ...current, activeProjectId: id })); setMode('edit'); setFeedback('idle'); setSelectedId(null); setHoveredId(null); setCandidates([]); setNotice('') }
  const createProject = () => {
    const next = makeProject(newProjectName.trim() || 'Nová mapa', newProjectContinent)
    if (firebaseUser && !cloudReadyRef.current) console.info('[Project sync] New project is local-only until the pending import/merge choice is completed', { uid: firebaseUser.uid, projectId: next.id })
    setStore((current) => ({ ...current, projects: [...current.projects, next], activeProjectId: next.id }))
    setNewProjectName(''); setShowCreate(false); setMode('edit'); setNotice('Nový projekt byl vytvořen.')
  }
  const renameProject = () => { const name = window.prompt('Nový název projektu:', project.name)?.trim(); if (name) updateProject((current) => ({ ...current, name })) }
  const deleteProject = () => {
    if (!window.confirm(`Opravdu smazat projekt „${project.name}“?`)) return
    setStore((current) => { const remaining = current.projects.filter((item) => item.id !== project.id); const fallback = remaining[0] ?? makeProject('Moje první mapa', 'europe'); return { ...current, projects: remaining.length ? remaining : [fallback], activeProjectId: remaining[0]?.id ?? fallback.id } })
    setMode('edit'); setFeedback('idle'); setSelectedId(null)
  }
  const handleProfileAction = async () => {
    if (!isFirebaseConfigured) {
      setAuthError('Doplň veřejnou Firebase Web konfiguraci do .env.local a do Vercelu.')
      return
    }
    setAuthError('')
    try {
      const firebase = firebaseAuthRef.current
      if (!firebase) throw new Error('Firebase Auth ještě není připraven. Obnov stránku a zkus to znovu.')
      if (firebaseUser) {
        setAuthStatus('signing-out')
        await firebase.signOutFirebaseUser()
      } else {
        setAuthStatus('signing-in')
        await firebase.signInWithGoogle()
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[Firebase Auth] Google authentication action failed', { code: code || 'unknown', message: errorMessage })
      setAuthStatus(firebaseUser ? 'signed-in' : 'signed-out')
      const message = code === 'auth/popup-closed-by-user'
        ? 'Přihlašovací okno bylo zavřeno.'
        : code === 'auth/popup-blocked'
          ? 'Prohlížeč zablokoval přihlašovací okno. Povol vyskakovací okna pro tento web a zkus to znovu.'
          : code === 'auth/operation-not-allowed'
            ? 'Přihlášení přes Google není pro tento Firebase projekt povolené.'
          : code === 'auth/unauthorized-domain'
            ? 'Tato doména není autorizována ve Firebase Console.'
            : code === 'auth/network-request-failed'
              ? 'Přihlášení se nepodařilo kvůli síťové chybě. Zkontroluj připojení a zkus to znovu.'
              : errorMessage || 'Přihlášení se nepodařilo.'
      setAuthError(message)
    }
  }
  const refreshLocalStoreSnapshot = () => {
    try {
      localRawStoreRef.current = localStorage.getItem(STORE_KEY)
      const parsed = parseProjectStore(localRawStoreRef.current)
      setHasLocalData(Boolean(parsed))
      setLocalMeasurement(parsed && localRawStoreRef.current ? measureLocalProjects(localRawStoreRef.current, parsed.projects) : null)
    } catch {
      localRawStoreRef.current = null
      setHasLocalData(false)
    }
    return localRawStoreRef.current
  }
  const useCloudProjects = async () => {
    try {
      const rawLocalStore = refreshLocalStoreSnapshot()
      if (rawLocalStore) {
        await backupLocalStore(localStorage, firebaseUser?.uid ?? 'unknown', rawLocalStore)
      }
      const projects = cloudProjects.map((item) => item.project)
      const savedStore = parseProjectStore(rawLocalStore)
      cloudBaselineRef.current = new Map(cloudProjects.map((item) => [item.project.id, item]))
      conflictsRef.current.clear()
      setStore({ version: 2, projects, activeProjectId: projects.find((item) => item.id === savedStore?.activeProjectId)?.id ?? projects[0]?.id ?? '' })
      cloudReadyRef.current = true
      setCloudReady(true)
      setSyncPrompt(null)
      setSyncStatus('ready')
      setSyncError('')
    } catch (error) {
      setSyncError(describeImportError(error))
      setSyncStatus('error')
    }
  }
  const importLocalProjects = async () => {
    const rawLocalStore = refreshLocalStoreSnapshot()
    if (!firebaseUser || !rawLocalStore || !repositoryRef.current) return
    try {
      const result = await migrateLocalProjects(repositoryRef.current, firebaseUser.uid, localStorage, rawLocalStore)
      setLocalMeasurement(result.measurement)
      const projects = await repositoryRef.current.listProjects(firebaseUser.uid)
      cloudBaselineRef.current = new Map(projects.map((item) => [item.project.id, item]))
      conflictsRef.current.clear()
      const parsed = parseProjectStore(rawLocalStore)
      setStore({ version: 2, projects: projects.map((item) => item.project), activeProjectId: projects.some((item) => item.project.id === parsed?.activeProjectId) ? parsed?.activeProjectId ?? projects[0]?.project.id ?? '' : projects[0]?.project.id ?? '' })
      cloudReadyRef.current = true
      setCloudReady(true)
      setSyncPrompt(null)
      setSyncStatus('ready')
      setSyncError(`Import dokončen: ${result.measurement.projectCount} projektů, ${result.measurement.featureCount} míst; localStorage ${formatByteSize(result.measurement.localStoreBytes)}, geometrie ${formatByteSize(result.measurement.geometryBytes)}, největší tvar ${formatByteSize(result.measurement.largestGeometryBytes)}. ${result.skippedCount ? `${result.skippedCount} kolidujících ID zůstalo beze změny. ` : ''}Záloha: ${result.backupKey}`)
    } catch (error) {
      setSyncError(describeImportError(error))
      setSyncStatus('error')
    }
  }
  const mergeLocalProjects = async () => {
    const rawLocalStore = refreshLocalStoreSnapshot()
    if (!firebaseUser || !rawLocalStore || !repositoryRef.current) return
    try {
      const result = await migrateLocalProjects(repositoryRef.current, firebaseUser.uid, localStorage, rawLocalStore)
      setLocalMeasurement(result.measurement)
      const projects = await repositoryRef.current.listProjects(firebaseUser.uid)
      cloudBaselineRef.current = new Map(projects.map((item) => [item.project.id, item]))
      conflictsRef.current.clear()
      setStore({ version: 2, projects: projects.map((item) => item.project), activeProjectId: projects[0]?.project.id ?? '' })
      cloudReadyRef.current = true
      setCloudReady(true)
      setSyncPrompt(null)
      setSyncStatus('ready')
      setSyncError(`Sloučení hotovo (${result.migrated.length} přidáno, ${result.skippedCount} existujících ID ponecháno). Místní localStorage ${formatByteSize(result.measurement.localStoreBytes)}, geometrie ${formatByteSize(result.measurement.geometryBytes)}, největší tvar ${formatByteSize(result.measurement.largestGeometryBytes)}. Záloha: ${result.backupKey}`)
    } catch (error) {
      setSyncError(describeImportError(error))
      setSyncStatus('error')
    }
  }
  const resolveCloudConflict = (id: string, useRemote: boolean) => {
    const conflict = syncConflicts.find((item) => item.id === id)
    if (!conflict) return
    const { cloud } = conflict
    conflictsRef.current.delete(id)
    if (cloud) cloudBaselineRef.current.set(id, cloud)
    else cloudBaselineRef.current.delete(id)
    if (useRemote) {
      if (cloud) {
        setStore((current) => ({ ...current, projects: current.projects.some((item) => item.id === id) ? current.projects.map((item) => item.id === id ? cloud.project : item) : [...current.projects, cloud.project] }))
      } else {
        setStore((current) => {
          const remaining = current.projects.filter((item) => item.id !== id)
          const fallback = remaining[0] ?? makeProject('Moje první mapa', 'europe')
          return { ...current, projects: remaining.length ? remaining : [fallback], activeProjectId: current.activeProjectId === id ? fallback.id : current.activeProjectId }
        })
      }
    }
    setSyncConflicts((current) => current.filter((item) => item.id !== id))
    setSyncError(useRemote ? 'Načetla se novější cloudová verze.' : 'Lokální verze byla ponechána a bude znovu synchronizována.')
    setSyncTick((value) => value + 1)
  }
  const shareProject = async () => {
    try {
      const shareUrl = new URL(configuredPublicUrl || window.location.href)
      shareUrl.hash = `shared=${encodeSharedProject(project)}`
      const url = shareUrl.toString()
      if (url.length > SHARE_URL_LIMIT) { setNotice('Geometrie tohoto projektu je příliš podrobná i po automatické optimalizaci pro sdílení. Prozatímní sdílení odkazem má limit 12 000 znaků.'); return }
      const localAddress = ['localhost', '127.0.0.1', '::1'].includes(shareUrl.hostname)
      const localWarning = localAddress ? ' Pozor: adresa localhost funguje pouze na tomto počítači. Pro sdílení na jiné zařízení aplikaci nasaď na veřejnou HTTPS adresu; můžeš ji nastavit jako VITE_PUBLIC_APP_URL.' : ''
      try { await navigator.clipboard.writeText(url); setNotice(`Odkaz na nezávislou kopii byl zkopírován.${localWarning}`) }
      catch { window.prompt('Zkopíruj odkaz na nezávislou kopii:', url); setNotice(`Odkaz připraven ke zkopírování.${localWarning}`) }
    } catch { setNotice('Odkaz se nepodařilo vytvořit.') }
  }

  const searchPlaces = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!query.trim()) return
    const requestId = ++searchRequestId.current
    setIsSearching(true); setNotice('')
    try {
      const results = await searchCandidates(query, placeType)
      if (searchRequestId.current !== requestId) return
      setCandidates(results)
      if (!results.length) setNotice('Místo se nepodařilo najít. Zkus upřesnit název.')
    } catch { if (searchRequestId.current === requestId) setNotice('Vyhledávání se nepodařilo dokončit. Zkontroluj připojení.') }
    finally { if (searchRequestId.current === requestId) setIsSearching(false) }
  }
  const addCandidate = (candidate: SearchCandidate) => {
    const name = getCandidateName(candidate)
    const duplicate = project.features.some((feature) => feature.name.toLocaleLowerCase() === name.toLocaleLowerCase() || (Math.abs(feature.lat - Number(candidate.lat)) < .0001 && Math.abs(feature.lng - Number(candidate.lon)) < .0001))
    if (duplicate) { setNotice('Tento pojem už v projektu existuje.'); return }
    const geometry = candidate.geojson && candidate.geojson.type !== 'Point' ? candidate.geojson : undefined
    const feature: Feature = { id: crypto.randomUUID(), name, type: placeType, lat: Number(candidate.lat), lng: Number(candidate.lon), displayName: candidate.display_name, geometry }
    updateProject((current) => ({ ...current, features: [...current.features, feature] })); setCandidates([]); setQuery(''); setNotice(geometry ? 'Místo i jeho geometrie byly přidány.' : 'Místo bylo přidáno jako bod; geometrie nebyla dostupná.')
  }
  const editFeature = useCallback((feature: Feature) => { const name = window.prompt('Název pojmu:', feature.name)?.trim(); if (!name || name === feature.name) return; updateProject((current) => ({ ...current, features: current.features.map((item) => item.id === feature.id ? { ...item, name } : item) })) }, [updateProject])
  const removeFeature = useCallback((id: string) => updateProject((current) => ({ ...current, features: current.features.filter((feature) => feature.id !== id), testOrder: current.testOrder.filter((item) => item !== id), testIndex: 0 })), [updateProject])
  const clearFeatures = () => { if (window.confirm('Opravdu vymazat všechny pojmy v tomto projektu?')) updateProject((current) => ({ ...current, features: [], testOrder: [], testIndex: 0 })) }
  const startTest = () => { if (!project.features.length) { setNotice('Nejdřív přidej alespoň jeden pojem.'); return } const order = [...project.features].sort(() => Math.random() - .5).map((feature) => feature.id); updateProject((current) => ({ ...current, testOrder: order, testIndex: 0, stats: { answered: 0, correct: 0, wrong: 0 } })); setMode('test'); setFeedback('idle'); setSelectedId(null); setHoveredId(null) }
  const nextQuestion = () => { updateProject((current) => ({ ...current, testIndex: current.testIndex + 1 })); setFeedback('idle'); setSelectedId(null); setHoveredId(null) }
  const evaluateFeature = useCallback((feature: Feature) => {
    if (mode !== 'test' || (feedback !== 'idle' && feedback !== 'far') || !target) return
    setSelectedId(feature.id)
    const correct = feature.id === target.id
    setFeedback(correct ? 'correct' : 'wrong')
    updateProject((current) => ({ ...current, stats: { answered: current.stats.answered + 1, correct: current.stats.correct + (correct ? 1 : 0), wrong: current.stats.wrong + (correct ? 0 : 1) } }))
  }, [feedback, mode, target, updateProject])
  const selectFeature = useCallback((feature: Feature, event: LeafletMouseEvent) => {
    event.originalEvent.stopPropagation()
    if (mode === 'edit') setSelectedId(feature.id)
    else evaluateFeature(feature)
  }, [evaluateFeature, mode])
  const answer = (event: HitEvent) => {
    if (mode !== 'test' || (feedback !== 'idle' && feedback !== 'far') || !target) return
    const nearest = project.features.map((feature) => ({ feature, distance: featureHitDistance(feature, event) })).sort((a, b) => a.distance - b.distance)[0]
    if (!nearest || !Number.isFinite(nearest.distance)) { setFeedback('far'); return }
    evaluateFeature(nearest.feature)
  }
  const handleFullscreen = useCallback(() => setIsFullscreen((value) => !value), [])
  const handleLayer = (layer: Project['mapLayer']) => updateProject((current) => ({ ...current, mapLayer: layer }))
  const handleDisplayMode = (displayMode: Project['displayMode']) => updateProject((current) => ({ ...current, displayMode }))

  return <main className={`app-shell ${darkMode ? 'dark-theme' : ''}`}>
    <header className="topbar"><div className="brand"><span className="brand-mark"><Compass size={18} /></span><span>atlas<span className="brand-accent">.</span>memo</span></div><div className="topbar-meta"><span className={`status-dot ${saveStatus === 'error' ? 'status-error' : ''}`} />{saveStatus === 'saving' ? 'Ukládám…' : saveStatus === 'error' ? 'Nepodařilo se uložit' : 'Uloženo'}<span className={`auth-status ${authStatus === 'error' ? 'auth-error' : ''}`} title={authError || (firebaseUser ? `Firebase UID: ${firebaseUser.uid}` : undefined)}>{authStatus === 'checking' ? 'Ověřuji profil…' : authStatus === 'signing-in' ? 'Přihlašuji…' : authStatus === 'signing-out' ? 'Odhlašuji…' : authStatus === 'unconfigured' ? 'Firebase nenastaven' : authStatus === 'error' ? 'Chyba přihlášení' : firebaseUser ? <><span>{firebaseUser.email || firebaseUser.displayName || 'Přihlášeno'}</span><small>UID: {firebaseUser.uid}</small></> : 'Nepřihlášeno'}</span><button className="avatar" onClick={handleProfileAction} disabled={!isFirebaseConfigured || authStatus === 'checking' || authStatus === 'signing-in' || authStatus === 'signing-out'} aria-label={firebaseUser ? `Odhlásit účet ${firebaseUser.email || ''}, Firebase UID ${firebaseUser.uid}` : 'Přihlásit se přes Google'} title={authError || (authStatus === 'unconfigured' ? 'Nejdřív nastav VITE_FIREBASE_* v .env.local.' : firebaseUser ? `Odhlásit se · Firebase UID: ${firebaseUser.uid}` : 'Přihlásit se přes Google')}>{authStatus === 'signing-in' || authStatus === 'signing-out' ? '…' : firebaseUser ? (firebaseUser.displayName?.trim().charAt(0).toUpperCase() || firebaseUser.email?.charAt(0).toUpperCase() || 'U') : 'G'}</button></div></header>
    {authError && <div className="auth-error-banner" role="alert" aria-live="assertive"><span>{authError}</span><button type="button" onClick={() => setAuthError('')} aria-label="Zavřít chybové upozornění">×</button></div>}
    <div className="workspace">
      <aside className="sidebar"><div className="sidebar-heading"><div><span className="eyebrow">MŮJ ATLAS</span><h1>Moje projekty</h1></div><button className="icon-button" onClick={() => setShowCreate(true)} aria-label="Nový projekt"><Plus size={18} /></button></div><div className="section-label">PROJEKTY</div><nav className="project-list">{store.projects.map((item) => <button key={item.id} className={`project-item ${item.id === project.id ? 'active' : ''}`} onClick={() => selectProject(item.id)}><span className="project-marker">{continentData[item.continent].short}</span><span className="project-name"><strong>{item.name}</strong><small>{continentData[item.continent].label} · {item.features.length} {item.features.length === 1 ? 'pojem' : 'pojmy'}</small></span>{item.id === project.id && <ChevronDown size={16} />}</button>)}</nav>
        <section className="sync-card" aria-live="polite">
          <strong>{!firebaseUser ? 'Přihlaste se pro synchronizaci projektů.' : syncStatus === 'loading' ? 'Načítám cloudové projekty…' : syncStatus === 'syncing' ? 'Synchronizuji…' : syncStatus === 'error' ? 'Synchronizace má problém' : syncPrompt ? 'Vyberte, jak bezpečně pokračovat' : syncConflicts.length ? 'Vyřešte konflikty synchronizace' : syncStatus === 'ready' ? 'Synchronizováno' : 'Synchronizace pozastavena'}</strong>
          {firebaseUser && syncPrompt === 'import' && <><span>Cloudový účet je prázdný. Místní projekty z tohoto prohlížeče lze importovat; před nahráním se uloží jejich přesná záloha.</span>{localMeasurement && <small>Naměřeno před importem: localStorage {formatByteSize(localMeasurement.localStoreBytes)}, geometrie {formatByteSize(localMeasurement.geometryBytes)}, největší tvar {formatByteSize(localMeasurement.largestGeometryBytes)}.</small>}<button onClick={importLocalProjects}>Zálohovat a importovat místní projekty</button></>}
          {firebaseUser && syncPrompt === 'choose' && <><span>V cloudu je {cloudProjects.length} {cloudProjects.length === 1 ? 'projekt' : 'projektů'}. Místní data nebudou přepsána bez vaší volby.</span>{hasLocalData && localMeasurement && <small>Naměřeno před volbou: localStorage {formatByteSize(localMeasurement.localStoreBytes)}, geometrie {formatByteSize(localMeasurement.geometryBytes)}, největší tvar {formatByteSize(localMeasurement.largestGeometryBytes)}.</small>}<button onClick={useCloudProjects}>Zálohovat místní data a použít cloud</button><button className="sync-secondary" onClick={mergeLocalProjects} disabled={!hasLocalData}>Sloučit (ID existující v cloudu přeskočit)</button></>}
          {syncConflicts.map((conflict) => <div className="sync-conflict" key={conflict.id}><span>{conflict.cloud ? `Projekt „${conflict.cloud.project.name}“ má novější cloudovou verzi.` : 'Projekt byl smazán z cloudu, ale místní verze obsahuje změny.'} Vyberte, kterou verzi ponechat.</span><div className="sync-actions"><button onClick={() => resolveCloudConflict(conflict.id, true)}>{conflict.cloud ? 'Načíst cloudovou verzi' : 'Potvrdit smazání'}</button><button className="sync-secondary" onClick={() => resolveCloudConflict(conflict.id, false)}>Ponechat a nahrát místní</button></div></div>)}
          {syncError && <small className={syncStatus === 'error' ? 'sync-error' : 'sync-note'}>{syncError}</small>}
          {firebaseUser && !syncPrompt && syncStatus === 'ready' && !syncConflicts.length && <span>Projekty tohoto účtu jsou synchronizované napříč zařízeními.</span>}
        </section>
        <div className="sidebar-note"><Sparkles size={16} /><div><strong>Uč se podle sebe</strong><span>Každý projekt má vlastní mapu a statistiky.</span></div></div><div className="sidebar-footer"><button className="theme-toggle" onClick={() => setDarkMode((value) => !value)}>{darkMode ? <Sun size={15} /> : <Moon size={15} />}{darkMode ? 'Světlý režim' : 'Tmavý režim'}</button><span className="saved-icon"><Check size={14} /></span><span>Automaticky ukládáme<br /><strong>v prohlížeči</strong></span></div></aside>
      <section className={`main-panel ${isFullscreen ? 'fullscreen-panel' : ''}`}><div className="content-header"><div><span className="eyebrow">PRACOVNÍ PROSTOR / {continent.label.toUpperCase()}</span><h2>{mode === 'edit' ? project.name : 'Najdi správné místo'}</h2><p>{mode === 'edit' ? 'Vytvoř si vlastní sbírku míst k procvičení.' : 'Klikni přímo na bod nebo objekt, který odpovídá zadání.'}</p></div><div className="header-actions"><button className="subtle-button" onClick={renameProject}><Pencil size={14} /> Přejmenovat</button><button className="subtle-button" onClick={shareProject}><Share2 size={14} /> Sdílet</button><button className="mode-button" onClick={deleteProject} aria-label="Smazat projekt"><Trash2 size={14} /></button><button className={`mode-button ${mode === 'edit' ? 'selected' : ''}`} onClick={() => { setMode('edit'); setFeedback('idle'); setSelectedId(null) }}><Pencil size={15} /> Upravit mapu</button><button className={`mode-button test ${mode === 'test' ? 'selected' : ''}`} onClick={startTest}><Target size={15} /> Testovat</button></div></div>
        {mode === 'test' && target && <div className={`quiz-banner ${feedback}`}><div className="quiz-label"><Target size={17} /><span>AKTUÁLNÍ ÚKOL</span></div><strong>Najdi: {target.name}</strong>{feedback === 'idle' && <span className="quiz-help">Objekty nemají popisky, dokud neodpovíš.</span>}{feedback === 'far' && <span className="feedback-text">Klikni na jeden z objektů na mapě.</span>}{feedback === 'correct' && <span className="feedback-text"><Check size={16} /> Správně!</span>}{feedback === 'wrong' && <span className="feedback-text">Špatně. Klikla jsi na „{project.features.find((feature) => feature.id === selectedId)?.name}“.</span>}{feedback !== 'idle' && feedback !== 'far' && <button onClick={nextQuestion} className="next-button">{project.testIndex + 1 >= project.testOrder.length ? 'Zobrazit shrnutí' : 'Další otázka'} <span>→</span></button>}</div>}
        {mode === 'test' && !target && <div className="quiz-banner complete"><strong>Test dokončen</strong><span>{stats.correct} / {stats.answered} správně · úspěšnost {stats.success} %</span><button onClick={startTest} className="next-button">Testovat znovu →</button></div>}
        <div className={`map-card ${isFullscreen ? 'map-card-fullscreen' : ''}`}><MapContainer key={project.id} center={continent.center} zoom={continent.zoom} minZoom={2} scrollWheelZoom zoomControl={false} preferCanvas className="map"><MapViewport onMapClick={answer} onFullscreen={handleFullscreen} resetView={{ center: continent.center, zoom: continent.zoom }} viewKey={project.id} mapLayer={project.mapLayer} isFullscreen={isFullscreen}>{project.mapLayer === 'normal' && <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />}{project.mapLayer === 'blind' && boundaryData && <GeoJSON data={boundaryData} interactive={false} style={{ color: '#8ca69b', weight: 1, fillColor: '#dfece4', fillOpacity: 0 }} />}
          <div className="map-layer-control" role="group" aria-label="Podklad mapy"><button className={project.mapLayer === 'blind' ? 'active' : ''} onClick={() => handleLayer('blind')}>Slepá mapa</button><button className={project.mapLayer === 'normal' ? 'active' : ''} onClick={() => handleLayer('normal')}>Normální mapa</button></div>
          {project.features.map((feature) => <span key={feature.id} className="feature-layer"><FeatureMapItem feature={feature} displayMode={project.displayMode} mode={mode} feedback={feedback} targetId={target?.id} selectedId={selectedId} hovered={hoveredId === feature.id} onSelect={selectFeature} onHover={setFeatureHovered} /></span>)}
        </MapViewport></MapContainer><div className="map-overlay"><span><span className="legend-dot" /> {project.features.length} {project.features.length === 1 ? 'pojem' : 'pojmy'} na mapě</span><span className="map-source"><MapPin size={13} />{project.mapLayer === 'blind' ? 'Hranice: Natural Earth' : '© OpenStreetMap contributors'}</span></div>{isFullscreen && mode === 'test' && <FullscreenTestContext context={quizContext} onClose={handleFullscreen} />}</div>
        <div className="display-mode-control" role="group" aria-label="Zobrazení objektů"><span>Zobrazení objektů</span><button className={project.displayMode === 'shape' ? 'active' : ''} onClick={() => handleDisplayMode('shape')}>Tvar</button><button className={project.displayMode === 'points' ? 'active' : ''} onClick={() => handleDisplayMode('points')}>Body</button></div>
        {mode === 'edit' ? <div className="editor-grid"><div className="add-panel"><div className="panel-title"><span className="number-badge">01</span><div><h3>Přidej místo</h3><p>Vyhledej skutečné místo a vyber správný výsledek.</p></div></div><form onSubmit={searchPlaces} className="search-form"><div className="search-input"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setNotice('') }} placeholder="Vyhledat místo..." autoComplete="off" aria-label="Vyhledat místo" aria-expanded={candidates.length > 0} aria-controls="place-suggestions" /><button type="button" aria-label="Vymazat hledání" onClick={() => { setQuery(''); setCandidates([]); setNotice('') }}><X size={15} /></button></div><div className="select-wrap"><select value={placeType} onChange={(event) => setPlaceType(event.target.value as PlaceType)}><option value="">Typ – volitelné</option><option>město</option><option>řeka</option><option>jezero</option><option>pohoří</option><option>stát</option><option>památka</option><option>jiný objekt</option></select><ChevronDown size={15} /></div><button className="add-button" disabled={isSearching}>{isSearching ? 'Hledám...' : <><Search size={16} /> Vyhledat</>}</button></form>{isSearching && query.trim().length >= 2 && <p className="search-status">Hledám návrhy…</p>}{candidates.length > 0 && <div id="place-suggestions" className="candidate-list" role="listbox" aria-label="Návrhy míst">{candidates.map((candidate) => <button type="button" role="option" aria-selected="false" key={candidate.place_id} onClick={() => addCandidate(candidate)}><MapPin size={15} /><span><strong>{getCandidateName(candidate)}</strong><small>{candidate.display_name}</small></span><Plus size={15} /></button>)}</div>}
        {notice && <p className={`notice ${notice.includes('nepodařilo') || notice.includes('existuje') || notice.includes('příliš velký') ? 'error' : ''}`}>{notice}</p>}
        <p className="data-note"><Crosshair size={14} /> Hranice z dat Natural Earth · objekty ukládají dostupnou geometrii.</p></div><div className="places-panel"><div className="list-heading"><div><span className="section-label">TVOJE POJMY</span><strong>{project.features.length} {project.features.length === 1 ? 'položka' : 'položek'}</strong></div><button onClick={clearFeatures} className="clear-button">Vymazat vše</button></div><div className="place-list">{project.features.length === 0 ? <div className="empty-state">Projekt je zatím prázdný.<br />Vyhledej první místo výše.</div> : project.features.map((feature, index) => <ProjectPlaceRow key={feature.id} feature={feature} index={index} selected={selectedId === feature.id} onSelect={selectPlaceRow} onEdit={editFeature} onRemove={removeFeature} />)}</div></div></div> : <div className="stats-panel"><div><span className="section-label">STATISTIKY PROJEKTU</span><strong>{stats.total} pojmů</strong></div><div><strong>{stats.answered}</strong><span>zodpovězeno</span></div><div><strong>{stats.correct}</strong><span>správně</span></div><div><strong>{stats.wrong}</strong><span>špatně</span></div><div><strong>{stats.success} %</strong><span>úspěšnost</span></div></div>}
      </section>
    </div>
    {showCreate && <div className="modal-backdrop" onClick={() => setShowCreate(false)}><div className="modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">NOVÝ PROJEKT</span><h3>Vytvoř vlastní mapu</h3></div><button className="icon-button" onClick={() => setShowCreate(false)}><X size={16} /></button></div><label>Název projektu<input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Např. Řeky Evropy" /></label><label>Kontinent<select value={newProjectContinent} onChange={(event) => setNewProjectContinent(event.target.value as Continent)}>{(Object.keys(continentData) as Continent[]).map((key) => <option key={key} value={key}>{continentData[key].label}</option>)}</select></label><button className="add-button modal-submit" onClick={createProject}><Plus size={16} /> Vytvořit projekt</button></div></div>}
  </main>
}

export default App