import { Composer } from '../../components/Composer.tsx';
import { CATEGORIES } from '../../src/domain/types.ts';

export const dynamic = 'force-dynamic';

const ComposePage = () => (
  <>
    <h1>Rager it or Rave it</h1>
    <p className="lede">Describe the behavior, not the person. You choose how you show up.</p>
    <Composer categories={[...CATEGORIES]} />
  </>
);

export default ComposePage;
