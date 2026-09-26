import { getApp, getApps, initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'
import type { Unsubscribe, User } from 'firebase/auth'
import { firebaseConfig, isFirebaseConfigured } from './firebaseConfig'

// All values here are the public Firebase Web App configuration, never an admin credential.
export const firebaseApp = isFirebaseConfigured
  ? (getApps().length ? getApp() : initializeApp(firebaseConfig))
  : null

export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null
export const firebaseDb = firebaseApp ? (() => {
  try {
    return initializeFirestore(firebaseApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })
  } catch {
    return getFirestore(firebaseApp)
  }
})() : null

export const observeFirebaseUser = (onUser: (user: User | null) => void, onError: (error: Error) => void): Unsubscribe => {
  if (!firebaseAuth) throw new Error('Firebase is not configured')
  return onAuthStateChanged(firebaseAuth, onUser, onError)
}

export const signInWithGoogle = async () => {
  if (!firebaseAuth) throw new Error('Firebase is not configured')
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  return signInWithPopup(firebaseAuth, provider)
}

export const signOutFirebaseUser = () => {
  if (!firebaseAuth) throw new Error('Firebase is not configured')
  return signOut(firebaseAuth)
}
