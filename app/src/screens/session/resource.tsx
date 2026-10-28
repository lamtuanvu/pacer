import type { ComponentChildren } from 'preact';
import { EmptyState, LoadingState } from '../../ds/Patterns';
import type { Resource } from './types';

export function ResourceView<T>({ value, empty, loading, children }: {
  value?: Resource<T>; empty: string; loading: string; children: (value: T) => ComponentChildren;
}) {
  if (value?.error) return <p role="alert">{value.error}</p>;
  if (value?.loading && value.data == null) return <LoadingState label={loading}/>;
  if (value?.data == null || value.data === '' || (Array.isArray(value.data) && !value.data.length)) return <EmptyState title={empty}/>;
  return <>{value.loading && <LoadingState updating label="Updating…"/>}{children(value.data)}</>;
}
