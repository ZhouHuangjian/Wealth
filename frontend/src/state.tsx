import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Item } from "./api";
import { api } from "./api";
export type Space = {
  id: string;
  name: string;
  role: string;
  base_currency: string;
  administration?: boolean;
  membership_role?: string | null;
};
type AppState = {
  space: Space;
  hidden: boolean;
  refresh: number;
  reload: () => void;
  refreshIdentity: () => void;
  openEvent: (item?: Item) => void;
  requestReveal: (action: () => void) => void;
  showDetail: (item: Item) => void;
};
export const WorkspaceContext = createContext<AppState>(null!);
export const useWorkspace = () => useContext(WorkspaceContext);
export function useResource<T = any>(resource: string, params = "") {
  const { space, refresh } = useWorkspace();
  const [data, setData] = useState<T | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const seq = useRef(0);
  const fetchData = useCallback(async () => {
    const current = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<T>(`/spaces/${space.id}/${resource}${params}`);
      if (current === seq.current) setData(result);
    } catch (e) {
      if (current === seq.current) {
        setError((e as Error).message);
        setData(null);
      }
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [space.id, resource, params]);
  useEffect(() => {
    setData(null);
    void fetchData();
    return () => {
      seq.current++;
    };
  }, [fetchData, refresh]);
  return { data, loading, error, retry: fetchData };
}

export function useDebounced<T>(value: T, delay = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
