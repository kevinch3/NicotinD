import { useNavigate } from 'react-router-dom';
import { useSearchStore } from '@/stores/search';

export function useNavigateAndSearch() {
  const navigate = useNavigate();
  const setQuery = useSearchStore((s) => s.setQuery);
  const setAutoSearch = useSearchStore((s) => s.setAutoSearch);

  return (query: string) => {
    setQuery(query);
    setAutoSearch(true);
    navigate('/');
  };
}
