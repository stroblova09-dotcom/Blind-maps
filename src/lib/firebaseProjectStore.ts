import { collection, doc, getDoc, getDocs, onSnapshot, writeBatch } from 'firebase/firestore'
import type { DocumentReference, Firestore } from 'firebase/firestore'
import { firebaseDb } from './firebase'
import { ProjectRepository } from '../projectRepository'
import type { DocumentMutation, DocumentPath, ProjectRepositoryAdapter } from '../projectRepository'

const requireDb = (): Firestore => {
  if (!firebaseDb) throw new Error('Firebase Firestore není nakonfigurován.')
  return firebaseDb
}

const projectCollection = (db: Firestore, uid: string) => collection(db, 'users', uid, 'projects')
const projectRef = (db: Firestore, uid: string, projectId: string) => doc(projectCollection(db, uid), projectId)
const featureCollection = (db: Firestore, uid: string, projectId: string) => collection(projectRef(db, uid, projectId), 'features')
const featureRef = (db: Firestore, uid: string, projectId: string, featureId: string) => doc(featureCollection(db, uid, projectId), featureId)
const geometryCollection = (db: Firestore, uid: string, projectId: string, featureId: string) => collection(featureRef(db, uid, projectId, featureId), 'geometryChunks')
const referenceFor = (db: Firestore, uid: string, path: DocumentPath): DocumentReference => {
  if (path.collection === 'projects') return projectRef(db, uid, path.projectId)
  if (path.collection === 'features') return featureRef(db, uid, path.projectId, path.featureId)
  return doc(geometryCollection(db, uid, path.projectId, path.featureId), path.chunkId)
}

const adapter: ProjectRepositoryAdapter = {
  async getProject(uid, id) {
    const snapshot = await getDoc(projectRef(requireDb(), uid, id))
    return snapshot.exists() ? snapshot.data() : null
  },
  async listProjects(uid) {
    const snapshot = await getDocs(projectCollection(requireDb(), uid))
    return snapshot.docs.map((item) => ({ id: item.id, data: item.data() }))
  },
  async listFeatures(uid, projectId) {
    const snapshot = await getDocs(featureCollection(requireDb(), uid, projectId))
    return snapshot.docs.map((item) => ({ id: item.id, data: item.data() }))
  },
  async listGeometryChunks(uid, projectId, featureId) {
    const snapshot = await getDocs(geometryCollection(requireDb(), uid, projectId, featureId))
    return snapshot.docs.map((item) => ({ id: item.id, data: item.data() }))
  },
  async commit(uid, mutations: DocumentMutation[]) {
    const batch = writeBatch(requireDb())
    for (const mutation of mutations) {
      const reference = referenceFor(requireDb(), uid, mutation.path)
      if (mutation.data) batch.set(reference, mutation.data)
      else batch.delete(reference)
    }
    await batch.commit()
  },
  watchProjects(uid, onChange, onError) {
    return onSnapshot(projectCollection(requireDb(), uid), onChange, onError)
  },
}

export const projectRepository = new ProjectRepository(adapter)