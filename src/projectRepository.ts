import type { Feature, Project } from './projectModel'
import { normalizeProject } from './projectModel'

export const FIRESTORE_CHUNK_BYTES = 128 * 1024
const SAFE_DOCUMENT_BYTES = 512 * 1024

export type CloudProject = { project: Project; revision: number; changeId: string; createdAt: number; updatedAt: number }
export type ProjectMetadata = Omit<Project, 'features'> & {
  schemaVersion: 1
  featureCount: number
  revision: number
  changeId: string
  createdAt: number
  updatedAt: number
}
export type FeatureMetadata = Omit<Feature, 'geometry'> & { order: number; geometryChunkCount: number; geometryByteLength: number }
export type StoredFeature = FeatureMetadata

export type DocumentPath =
  | { collection: 'projects'; projectId: string }
  | { collection: 'features'; projectId: string; featureId: string }
  | { collection: 'geometryChunks'; projectId: string; featureId: string; chunkId: string }
export type DocumentMutation = { path: DocumentPath; data: Record<string, unknown> | null }
export type ProjectRepositoryAdapter = {
  getProject: (uid: string, projectId: string) => Promise<Record<string, unknown> | null>
  listProjects: (uid: string) => Promise<Array<{ id: string; data: Record<string, unknown> }>>
  listFeatures: (uid: string, projectId: string) => Promise<Array<{ id: string; data: Record<string, unknown> }>>
  listGeometryChunks: (uid: string, projectId: string, featureId: string) => Promise<Array<{ id: string; data: Record<string, unknown> }>>
  commit: (uid: string, mutations: DocumentMutation[]) => Promise<void>
  watchProjects: (uid: string, onChange: () => void, onError: (error: Error) => void) => () => void
}

export class ProjectRevisionConflictError extends Error {
  readonly projectId: string

  constructor(projectId: string) {
    super('Cloud project changed since it was last loaded.')
    this.name = 'ProjectRevisionConflictError'
    this.projectId = projectId
  }
}

const byteLength = (value: string) => new TextEncoder().encode(value).length
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
  }
  return btoa(binary)
}
const base64ToBytes = (value: string) => {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export const splitGeometry = (geometry: Feature['geometry']) => {
  if (!geometry) return { chunks: [] as string[], byteLength: 0 }
  const bytes = new TextEncoder().encode(JSON.stringify(geometry))
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += FIRESTORE_CHUNK_BYTES) {
    chunks.push(bytesToBase64(bytes.subarray(offset, Math.min(offset + FIRESTORE_CHUNK_BYTES, bytes.length))))
  }
  return { chunks, byteLength: bytes.length }
}

export const joinGeometry = (chunks: string[], expectedByteLength: number): Feature['geometry'] => {
  const decodedChunks = chunks.map(base64ToBytes)
  const bytes = new Uint8Array(decodedChunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const decoded of decodedChunks) {
    bytes.set(decoded, offset)
    offset += decoded.length
  }
  if (bytes.length !== expectedByteLength) throw new Error('Cloud geometry data is incomplete or corrupted.')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Feature['geometry']
}

export const projectToFirestore = (project: Project, revision: number, createdAt: number, updatedAt: number, changeId = crypto.randomUUID()): ProjectMetadata => {
  const metadata: ProjectMetadata = {
    id: project.id,
    name: project.name,
    continent: project.continent,
    mapLayer: project.mapLayer,
    displayMode: project.displayMode,
    testOrder: project.testOrder,
    testIndex: project.testIndex,
    stats: project.stats,
    schemaVersion: 1,
    featureCount: project.features.length,
    revision,
    changeId,
    createdAt,
    updatedAt,
  }
  if (byteLength(JSON.stringify(metadata)) > SAFE_DOCUMENT_BYTES) throw new Error('Nastavení projektu je příliš velké pro bezpečné uložení.')
  return metadata
}

const toStoredFeature = (feature: Feature, order: number, geometryChunkCount: number, geometryByteLength: number): StoredFeature => {
  return {
    id: feature.id,
    name: feature.name,
    type: feature.type,
    lat: feature.lat,
    lng: feature.lng,
    ...(feature.displayName !== undefined ? { displayName: feature.displayName } : {}),
    order,
    geometryChunkCount,
    geometryByteLength,
  }
}

export const firestoreToProject = (metadata: Record<string, unknown>, features: Feature[]): CloudProject => ({
  project: normalizeProject({ ...metadata, features } as Partial<Project>),
  revision: Number(metadata.revision) || 0,
  changeId: String(metadata.changeId ?? ''),
  createdAt: Number(metadata.createdAt) || 0,
  updatedAt: Number(metadata.updatedAt) || 0,
})

const assertDocumentId = (id: string) => {
  if (!id || id.includes('/')) throw new Error('ID projektu nebo místa není platné pro Firestore.')
}

export class ProjectRepository {
  private readonly adapter: ProjectRepositoryAdapter
  private readonly now: () => number

  constructor(adapter: ProjectRepositoryAdapter, now = () => Date.now()) {
    this.adapter = adapter
    this.now = now
  }

  async listProjects(uid: string): Promise<CloudProject[]> {
    const projectDocs = await this.adapter.listProjects(uid)
    return Promise.all(projectDocs.map(async ({ id, data }) => {
      const featureDocs = await this.adapter.listFeatures(uid, id)
      const withOrder = await Promise.all(featureDocs.map(async ({ id: featureId, data: featureData }) => {
        const feature = featureData as unknown as FeatureMetadata
        let geometry: Feature['geometry']
        if (feature.geometryChunkCount > 0) {
          const chunkDocs = await this.adapter.listGeometryChunks(uid, id, featureId)
          const orderedChunks = chunkDocs.sort((a, b) => Number(a.data.index) - Number(b.data.index))
          if (orderedChunks.length !== feature.geometryChunkCount) throw new Error(`Geometrie místa „${feature.name}“ není kompletní.`)
          geometry = joinGeometry(orderedChunks.map((chunk) => String(chunk.data.data)), feature.geometryByteLength)
        }
        const restoredFeature: Feature = {
          id: feature.id,
          name: feature.name,
          type: feature.type,
          lat: feature.lat,
          lng: feature.lng,
          ...(feature.displayName !== undefined ? { displayName: feature.displayName } : {}),
          ...(geometry ? { geometry } : {}),
        }
        return { feature: restoredFeature, order: feature.order }
      }))
      withOrder.sort((a, b) => a.order - b.order)
      return firestoreToProject(data, withOrder.map(({ feature }) => feature))
    }))
  }

  watchProjects(uid: string, onProjects: (projects: CloudProject[]) => void, onError: (error: Error) => void) {
    let generation = 0
    const unsubscribe = this.adapter.watchProjects(uid, () => {
      const current = ++generation
      this.listProjects(uid).then((projects) => { if (current === generation) onProjects(projects) }).catch(onError)
    }, onError)
    return () => { generation++; unsubscribe() }
  }

  async saveProject(uid: string, project: Project, expectedRevision?: number): Promise<CloudProject> {
    assertDocumentId(project.id)
    const existing = await this.adapter.getProject(uid, project.id)
    if (expectedRevision === 0 && existing) throw new ProjectRevisionConflictError(project.id)
    if (expectedRevision !== undefined && expectedRevision > 0 && (!existing || Number(existing.revision) !== expectedRevision)) throw new ProjectRevisionConflictError(project.id)
    const revision = (Number(existing?.revision) || 0) + 1
    const createdAt = Number(existing?.createdAt) || this.now()
    const updatedAt = Math.max(this.now(), Number(existing?.updatedAt ?? 0) + 1)
    const changeId = crypto.randomUUID()
    const existingFeatures = await this.adapter.listFeatures(uid, project.id)
    const oldFeatureIds = new Set(existingFeatures.map(({ id }) => id))
    const mutations: DocumentMutation[] = []

    for (const [order, feature] of project.features.entries()) {
      assertDocumentId(feature.id)
      const previous = existingFeatures.find(({ id }) => id === feature.id)
      const previousData = previous?.data as FeatureMetadata | undefined
      let oldChunks: Array<{ id: string; data: Record<string, unknown> }> = []
      let unchanged: boolean
      if (previousData?.geometryChunkCount) {
        oldChunks = await this.adapter.listGeometryChunks(uid, project.id, feature.id)
        const ordered = oldChunks.sort((a, b) => Number(a.data.index) - Number(b.data.index))
        const oldGeometry = joinGeometry(ordered.map((chunk) => String(chunk.data.data)), previousData.geometryByteLength)
        unchanged = JSON.stringify(oldGeometry) === JSON.stringify(feature.geometry ?? null)
      } else {
        unchanged = !feature.geometry
      }
      const encoded = unchanged ? null : splitGeometry(feature.geometry)
      const chunks = encoded?.chunks ?? []
      const chunkCount = unchanged ? previousData?.geometryChunkCount ?? 0 : chunks.length
      const geometryLength = unchanged ? previousData?.geometryByteLength ?? 0 : encoded?.byteLength ?? 0
      const storedFeature = toStoredFeature(feature, order, chunkCount, geometryLength)
      if (byteLength(JSON.stringify(storedFeature)) > SAFE_DOCUMENT_BYTES) throw new Error(`Údaje místa „${feature.name}“ překračují bezpečný limit dokumentu.`)
      mutations.push({ path: { collection: 'features', projectId: project.id, featureId: feature.id }, data: storedFeature as unknown as Record<string, unknown> })

      if (!unchanged) {
        oldChunks.forEach(({ id }) => mutations.push({ path: { collection: 'geometryChunks', projectId: project.id, featureId: feature.id, chunkId: id }, data: null }))
        chunks.forEach((chunk, index) => mutations.push({
          path: { collection: 'geometryChunks', projectId: project.id, featureId: feature.id, chunkId: `chunk_${String(index).padStart(6, '0')}` },
          data: { index, data: chunk },
        }))
      }
      oldFeatureIds.delete(feature.id)
    }

    for (const featureId of oldFeatureIds) {
      const oldChunks = await this.adapter.listGeometryChunks(uid, project.id, featureId)
      oldChunks.forEach(({ id }) => mutations.push({ path: { collection: 'geometryChunks', projectId: project.id, featureId, chunkId: id }, data: null }))
      mutations.push({ path: { collection: 'features', projectId: project.id, featureId }, data: null })
    }

    const metadata = projectToFirestore(project, revision, createdAt, updatedAt, changeId)
    await this.commitInBatches(uid, mutations)
    await this.adapter.commit(uid, [{ path: { collection: 'projects', projectId: project.id }, data: { ...metadata, id: project.id } }])
    return { project: structuredClone(project), revision, changeId, createdAt, updatedAt }
  }

  async deleteProject(uid: string, projectId: string) {
    assertDocumentId(projectId)
    const features = await this.adapter.listFeatures(uid, projectId)
    const mutations: DocumentMutation[] = []
    for (const feature of features) {
      const chunks = await this.adapter.listGeometryChunks(uid, projectId, feature.id)
      chunks.forEach(({ id }) => mutations.push({ path: { collection: 'geometryChunks', projectId, featureId: feature.id, chunkId: id }, data: null }))
      mutations.push({ path: { collection: 'features', projectId, featureId: feature.id }, data: null })
    }
    mutations.push({ path: { collection: 'projects', projectId }, data: null })
    await this.commitInBatches(uid, mutations)
  }

  private async commitInBatches(uid: string, mutations: DocumentMutation[]) {
    for (let offset = 0; offset < mutations.length; offset += 400) {
      await this.adapter.commit(uid, mutations.slice(offset, offset + 400))
    }
  }
}

export type LocalStorageLike = Pick<Storage, 'getItem' | 'setItem'>
export const localBackupKey = (uid: string, timestamp: number) => `atlas-memo-projects-v2.backup.${encodeURIComponent(uid)}.${timestamp}`

export const backupLocalStore = (storage: LocalStorageLike, uid: string, rawStore: string, timestamp = Date.now()) => {
  const key = localBackupKey(uid, timestamp)
  storage.setItem(key, rawStore)
  return key
}

export const measureLocalProjects = (rawStore: string, projects: Project[]) => {
  const geometries = projects.flatMap((project) => project.features.flatMap((feature) => feature.geometry ? [byteLength(JSON.stringify(feature.geometry))] : []))
  return {
    localStoreBytes: byteLength(rawStore),
    projectCount: projects.length,
    featureCount: projects.reduce((total, project) => total + project.features.length, 0),
    geometryBytes: geometries.reduce((total, size) => total + size, 0),
    largestGeometryBytes: Math.max(0, ...geometries),
  }
}

export const migrateLocalProjects = async (
  repository: Pick<ProjectRepository, 'saveProject' | 'listProjects'>,
  uid: string,
  storage: LocalStorageLike,
  rawStore: string,
) => {
  const parsed = JSON.parse(rawStore) as { version?: number; projects?: Project[] }
  if (parsed.version !== 2 || !Array.isArray(parsed.projects) || !parsed.projects.length) throw new Error('Lokální projekty se nepodařilo bezpečně načíst.')
  const backupKey = backupLocalStore(storage, uid, rawStore)
  const measurement = measureLocalProjects(rawStore, parsed.projects)
  const existing = await repository.listProjects(uid)
  const existingIds = new Set(existing.map(({ project }) => project.id))
  const migrated: CloudProject[] = []
  for (const sourceProject of parsed.projects) {
    if (existingIds.has(sourceProject.id)) continue
    migrated.push(await repository.saveProject(uid, sourceProject, 0))
  }
  return { backupKey, migrated, skippedCount: parsed.projects.length - migrated.length, measurement }
}