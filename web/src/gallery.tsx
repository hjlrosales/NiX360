import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, formatBytes, formatDuration, type MediaItem } from './api.ts';
import { Viewer } from './viewer.tsx';

export type GalleryFilter = {
  type?: 'photo' | 'video';
  projection?: 'equirectangular' | 'flat' | 'dual_fisheye';
  history?: boolean;
  favorite?: boolean;
};

type FolderData = {
  path: string;
  mediaCount: number;
  truncated: boolean;
  folders: { name: string; path: string; count: number }[];
};

type Props = {
  title: string;
  subtitle?: string;
  filter?: GalleryFilter;
  emptyTitle: string;
  emptyHint: string;
  /** Enables file-name search and folder navigation for this view. */
  navigable?: boolean;
  /** Administrators can edit catalog metadata such as the panorama start view. */
  canEdit?: boolean;
};

function badge(item: MediaItem): string | null {
  if (item.processingState === 'unsupported') return 'Requires conversion';
  if (item.processingState === 'failed') return 'Processing failed';
  if (item.processingState === 'pending' || item.processingState === 'processing') return 'Processing';
  if (item.projection === 'equirectangular') return '360°';
  if (item.projection === 'dual_fisheye') return 'Dual fisheye';
  if (item.type === 'video') return formatDuration(item.durationMs) || 'Video';
  return null;
}

export function Gallery({ title, subtitle, filter = {}, emptyTitle, emptyHint, navigable = false, canEdit = false }: Props) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorCode, setErrorCode] = useState('');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [folder, setFolder] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [folderData, setFolderData] = useState<FolderData | null>(null);

  const { type, projection, history, favorite } = filter;

  useEffect(() => {
    if (!navigable) return;
    let cancelled = false;
    api
      .folders(folder)
      .then((data) => {
        if (!cancelled) setFolderData(data);
      })
      .catch(() => {
        if (!cancelled) setFolderData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [navigable, folder]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setItems([]);
    setCursor(null);
    const query: Record<string, string> = { limit: '60' };
    if (type) query.type = type;
    if (projection) query.projection = projection;
    if (history) query.history = '1';
    if (favorite) query.favorite = '1';
    if (folder) query.folder = folder;
    if (search) query.q = search;
    if (from) query.from = from;
    if (to) query.to = to;

    api
      .library(query)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorCode(error instanceof Error ? error.message : 'request_failed');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [type, projection, history, favorite, folder, search, from, to]);

  async function loadMore() {
    if (!cursor || more) return;
    setMore(true);
    const query: Record<string, string> = { limit: '60', cursor };
    if (type) query.type = type;
    if (projection) query.projection = projection;
    if (history) query.history = '1';
    if (favorite) query.favorite = '1';
    if (folder) query.folder = folder;
    if (search) query.q = search;
    if (from) query.from = from;
    if (to) query.to = to;
    try {
      const page = await api.library(query);
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setErrorCode('request_failed');
    } finally {
      setMore(false);
    }
  }

  function setFavorite(index: number, value: boolean) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, favorite: value } : item)));
  }

  const segments = folder === '' ? [] : folder.split('/');

  return (
    <section class="page">
      <header class="page-header">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p class="muted">{subtitle}</p> : null}
        </div>
        {status === 'ready' ? <span class="count">{items.length} loaded</span> : null}
      </header>

      {navigable ? (
        <div class="library-tools">
          <form
            class="search-bar"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchInput.trim());
            }}
          >
            <input
              type="search"
              name="q"
              aria-label="Search library by file name"
              placeholder="Search file names"
              value={searchInput}
              onInput={(event) => setSearchInput((event.target as HTMLInputElement).value)}
            />
            <button class="button" type="submit">
              Search
            </button>
          </form>

          {search ? (
            <p class="muted small">
              Showing matches for “{search}”.{' '}
              <button
                class="link-button"
                type="button"
                onClick={() => {
                  setSearch('');
                  setSearchInput('');
                }}
              >
                Clear search
              </button>
            </p>
          ) : (
            <>
              <div class="date-range">
                <label class="muted small">
                  From{' '}
                  <input
                    type="date"
                    value={from}
                    max={to || undefined}
                    onInput={(event) => setFrom((event.target as HTMLInputElement).value)}
                  />
                </label>
                <label class="muted small">
                  To{' '}
                  <input
                    type="date"
                    value={to}
                    min={from || undefined}
                    onInput={(event) => setTo((event.target as HTMLInputElement).value)}
                  />
                </label>
                {from || to ? (
                  <button
                    class="link-button"
                    type="button"
                    onClick={() => {
                      setFrom('');
                      setTo('');
                    }}
                  >
                    Clear dates
                  </button>
                ) : null}
              </div>

              <nav class="breadcrumb" aria-label="Folder path">
                <button class="crumb" type="button" onClick={() => setFolder('')} aria-current={folder === '' ? 'page' : undefined}>
                  Photos
                </button>
                {segments.map((segment, index) => {
                  const target = segments.slice(0, index + 1).join('/');
                  return (
                    <Fragment key={target}>
                      <span class="crumb-sep" aria-hidden="true">
                        /
                      </span>
                      <button
                        class="crumb"
                        type="button"
                        onClick={() => setFolder(target)}
                        aria-current={index === segments.length - 1 ? 'page' : undefined}
                      >
                        {segment}
                      </button>
                    </Fragment>
                  );
                })}
              </nav>

              {folderData && folderData.folders.length > 0 ? (
                <ul class="folder-list" aria-label="Subfolders">
                  {folderData.folders.map((entry) => (
                    <li key={entry.path}>
                      <button class="folder-chip" type="button" onClick={() => setFolder(entry.path)}>
                        {entry.name} <span class="muted small">{entry.count}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {folderData?.truncated ? <p class="muted small">Folder counts are partial for very large libraries.</p> : null}
            </>
          )}
        </div>
      ) : null}

      {status === 'loading' ? (
        <div class="grid" aria-busy="true">
          {Array.from({ length: 12 }, (_, index) => (
            <div class="tile skeleton" key={index} />
          ))}
        </div>
      ) : null}

      {status === 'error' ? (
        <div class="notice error">
          <h3>Could not load this view</h3>
          <p>{errorCode === 'unauthenticated' ? 'Your session ended. Sign in again.' : 'The library request failed.'}</p>
        </div>
      ) : null}

      {status === 'ready' && items.length === 0 ? (
        <div class="notice">
          <h3>{search ? `No matches for “${search}”` : folder ? 'This folder is empty' : emptyTitle}</h3>
          <p>{search ? 'Try a different file name, or clear the search.' : folder ? 'No indexed media is stored directly in this folder.' : emptyHint}</p>
        </div>
      ) : null}

      {status === 'ready' && items.length > 0 ? (
        <>
          <ul class="grid">
            {items.map((item, index) => {
              const label = badge(item);
              return (
                <li key={item.id}>
                  <button class="tile" type="button" onClick={() => setViewerIndex(index)}>
                    <img
                      src={item.thumbnailUrl}
                      alt={item.fileName}
                      loading="lazy"
                      decoding="async"
                      width={400}
                      height={400}
                    />
                    {label ? <span class="tile-badge">{label}</span> : null}
                    {item.favorite ? (
                      <span class="tile-favorite" aria-label="Favorite">
                        ★
                      </span>
                    ) : null}
                    <span class="tile-caption">
                      <span>{item.fileName}</span>
                      <span class="muted small">{formatBytes(item.sizeBytes)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {cursor ? (
            <div class="load-more">
              <button class="button" type="button" onClick={loadMore} disabled={more}>
                {more ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {viewerIndex !== null && items[viewerIndex] ? (
        <Viewer
          items={items}
          index={viewerIndex}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onFavorite={setFavorite}
          canEdit={canEdit}
        />
      ) : null}
    </section>
  );
}
