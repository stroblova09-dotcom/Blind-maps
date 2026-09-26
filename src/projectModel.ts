import type { Geometry as GeoJsonGeometry } from 'geojson'

export type Continent = 'europe' | 'asia' | 'africa' | 'americas' | 'oceania' | 'world'
export type PlaceType = '' | 'město' | 'řeka' | 'jezero' | 'pohoří' | 'stát' | 'památka' | 'jiný objekt'
export type Feature = { id: string; name: string; type: PlaceType; lat: number; lng: number; displayName?: string; geometry?: GeoJsonGeometry }
export type Project = { id: string; name: string; continent: Continent; features: Feature[]; mapLayer: 'blind' | 'normal'; displayMode: 'shape' | 'points'; testOrder: string[]; testIndex: number; stats: { answered: number; correct: number; wrong: number } }
export type Store = { version: 2; projects: Project[]; activeProjectId: string }

export const STORE_KEY = 'atlas-memo-projects-v2'
const continents: Continent[] = ['europe', 'asia', 'africa', 'americas', 'oceania', 'world']

export const normalizeProject = (value: Partial<Project>): Project => ({
  id: value.id || crypto.randomUUID(),
  name: value.name || 'Mapa bez názvu',
  continent: value.continent && continents.includes(value.continent) ? value.continent : 'europe',
  features: Array.isArray(value.features) ? value.features : [],
  mapLayer: value.mapLayer === 'normal' ? 'normal' : 'blind',
  displayMode: value.displayMode === 'points' ? 'points' : 'shape',
  testOrder: Array.isArray(value.testOrder) ? value.testOrder : [],
  testIndex: Number.isInteger(value.testIndex) && (value.testIndex as number) >= 0 ? value.testIndex as number : 0,
  stats: { answered: value.stats?.answered ?? 0, correct: value.stats?.correct ?? 0, wrong: value.stats?.wrong ?? 0 },
})

export const parseProjectStore = (value: string | null): Store | null => {
  try {
    const parsed = value ? JSON.parse(value) as Partial<Store> : null
    if (parsed?.version !== 2 || !Array.isArray(parsed.projects) || !parsed.projects.length) return null
    const projects = parsed.projects.map((item) => normalizeProject(item))
    return { version: 2, projects, activeProjectId: projects.some((item) => item.id === parsed.activeProjectId) ? parsed.activeProjectId as string : projects[0].id }
  } catch {
    return null
  }
}

export const serializeProjectStore = (store: Store) => JSON.stringify(store)