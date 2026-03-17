import { createContext, useContext } from 'react';

// Provides { currentUser, isAdmin } to any component in the tree.
// Usage: const { isAdmin } = useAuth();

export const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}
