import { render } from 'preact';
import { Skeleton, type SkeletonLayout } from '../../../app/src/ds/Skeleton';
import { ResourceView } from '../../../app/src/screens/session/resource';

const root = document.getElementById('fixture')!;
document.addEventListener('skeleton:mount', event => {
  const layout = (event as CustomEvent<SkeletonLayout>).detail;
  render(<Skeleton key={layout} layout={layout} label="Loading the task" />, root);
});
document.addEventListener('skeleton:clear', () => render(null, root));
document.addEventListener('skeleton:refresh', () => render(<ResourceView value={{ data: 'Existing content', loading: true }} loading="Loading content" empty="Empty">{value => <p>{value}</p>}</ResourceView>, root));
