import type { ComponentChildren } from 'preact';
import { EmptyState, Skeleton } from '../../ds/Patterns';
import type { Resource } from './types';

export function ResourceView<T>({ value, empty, loading, layout = 'rows', children }: {
  value?: Resource<T>; empty: string; loading: string; layout?: import('../../ds/Skeleton').SkeletonLayout; children: (value: T) => ComponentChildren;
}) {
  if (value?.error) return <p role="alert">{value.error}</p>;
  if (value?.loading && value.data == null) return <Skeleton layout={layout} label={loading}/>;
  if (value?.data == null || value.data === '' || (Array.isArray(value.data) && !value.data.length)) return <EmptyState title={empty}/>;
  return <>{children(value.data)}</>;
}
