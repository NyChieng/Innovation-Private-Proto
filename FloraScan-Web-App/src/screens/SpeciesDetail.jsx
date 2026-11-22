import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ConservationBadge, Empty, LoadingBlock, PageHead, PlantCard } from '../components/ui.jsx';
import { Reveal } from '../components/motion.jsx';
import { speciesReferencePhoto } from '../lib/photo.js';
import { GROWTH_FORM, titleCase } from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

export default function SpeciesDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setData(null); setMissing(false);
    api.speciesById(id).then(setData).catch(() => setMissing(true));
  }, [id]);

  if (missing) {
    return (
      <div className="page"><div className="wrap wrap-narrow">
        <Empty icon={I.Book} title={t('Species not found')} action={<Link className="btn" to="/species">{t('Back to species list')}</Link>} />
      </div></div>
    );
  }
  if (!data) return <LoadingBlock label={t('Loading species')} />;

  const s = data.species;
  const photo = speciesReferencePhoto(s);
  const sections = [
    [t('Description'), s.description],
    [t('Distinguishing characteristics'), s.characteristics],
    [t('Leaves'), s.leaf_description],
    [t('Flowers'), s.flower_description],
    [t('Fruit'), s.fruit_description],
    [t('Habitat'), s.habitat],
    [t('Distribution'), s.distribution],
  ].filter(([, v]) => v);

  return (
    <div className="page">
      <div className="wrap">
        <PageHead
          back={{ to: '/species', label: t('All species') }}
          title={<span className="sci">{s.scientific_name}</span>}
          sub={[s.common_name, s.local_name].filter(Boolean).join(' · ')}
        >
          <ConservationBadge code={s.conservation_code} />
        </PageHead>

        {photo?.credit && (
          <p className="small mute">
            {t('Species photo credit')}{' · '}{photo.credit}
            {photo.license && <> · {photo.license}</>}
            {photo.url && <> · <a href={photo.url} target="_blank" rel="noreferrer">{photo.source || t('Photo source')}</a></>}
          </p>
        )}

        <div style={{ display: 'grid', gap: 22, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', alignItems: 'start' }}>
          <Reveal index={0}>
            <div className="card">
              <div className="card-head"><h3>{t('Classification')}</h3></div>
              <div className="card-body" style={{ paddingBlock: 6 }}>
                <dl className="dl">
                  <dt>{t('Family')}</dt><dd><Link to={'/browse?family=' + encodeURIComponent(s.family || '')}>{s.family || '--'}</Link></dd>
                  <dt>{t('Genus')}</dt><dd className="sci">{s.genus || '--'}</dd>
                  <dt>{t('Epithet')}</dt><dd className="sci">{s.species_epithet || '--'}</dd>
                  <dt>{t('Growth form')}</dt><dd>{s.growth_form ? (GROWTH_FORM[s.growth_form] || titleCase(s.growth_form)) : '--'}</dd>
                  <dt>{t('Conservation')}</dt><dd>{s.conservation_label}</dd>
                  <dt>{t('Specimens')}</dt><dd>{s.plant_count} in the register</dd>
                </dl>
              </div>
            </div>
          </Reveal>

          {sections.length > 0 && (
            <Reveal index={1}>
              <div className="card card-pad">
                <div className="prose">
                  {sections.map(([title, text]) => (
                    <div key={title}><h3>{title}</h3><p>{text}</p></div>
                  ))}
                </div>
              </div>
            </Reveal>
          )}
        </div>

        <h2 style={{ margin: '28px 0 14px' }}>
          {t('Specimens in the park')} <span className="mute" style={{ fontWeight: 400 }}>({data.plants.length})</span>
        </h2>
        {data.plants.length === 0 ? (
          <Empty icon={I.Leaf} title={t('No specimens of this species are published yet')} />
        ) : (
          <div className="plant-grid">
            {data.plants.map((p, i) => (
              <Reveal key={p.id} index={i % 6}>
                <PlantCard plant={p} showStatus={p.status !== 'approved'} />
              </Reveal>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
