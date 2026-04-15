import { createContext, useContext } from 'react';

// Provides { currentUser, isAdmin, isInvestor } to any component in the tree.
// Usage: const { isAdmin, isInvestor } = useAuth();

export const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}
