import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User,
  type ConfirmationResult,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Named distinctly (not the default app) so this app's Firebase Auth session
// is stored under its own key, isolated from the farm-app's — both are served
// from the same origin (same domain, different path), and the default app
// name would otherwise share one browser-storage session between an Owner
// signed into the farm app and a Manager signed into this app on the same
// device/browser.
const app: FirebaseApp = initializeApp(firebaseConfig, "manager-app");
export const auth = getAuth(app);

/** Fresh Firebase ID token for the signed-in manager, or null if signed out. */
export async function getIdToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

let recaptchaVerifier: RecaptchaVerifier | null = null;

/**
 * Sends an OTP to `phoneNumber` (E.164 format, e.g. "+91XXXXXXXXXX"). Only a
 * phone number the farm's owner has already added as a manager (see
 * managersTable) will actually be let in server-side — this just gets the
 * device a Firebase identity to present.
 */
export function sendPhoneOtp(phoneNumber: string, containerId: string): Promise<ConfirmationResult> {
  if (!recaptchaVerifier) {
    recaptchaVerifier = new RecaptchaVerifier(auth, containerId, { size: "invisible" });
  }
  return signInWithPhoneNumber(auth, phoneNumber, recaptchaVerifier);
}

export function signOutUser() {
  return firebaseSignOut(auth);
}

export { onAuthStateChanged };
export type { User, ConfirmationResult };
