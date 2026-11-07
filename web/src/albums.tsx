import { useEffect, useState } from 'preact/hooks';
import { api, formatDate, type Album, type MediaItem } from './api.ts';
import { Viewer } from './viewer.tsx';

export function AlbumsPage() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<{ album: Album; items: MediaItem[] } | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  async function refresh() {
    try {
      const result = await api.albums();
      setAlbums(result.albums);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create(event: Event) {
    event.preventDefault();
    if (title.trim() === '') return;
    await api.createAlbum(title.trim());
    setTitle('');
    await refresh();
  }

  async function open(album: Album) {
    const result = await api.album(album.id);
    setSelected({ album, items: result.items });
  }

  async function removeItem(mediaId: string) {
    if (!selected) return;
    await api.removeFromAlbum(selected.album.id, mediaId);
    setSelected({ ...selected, items: selected.items.filter((item) => item.id !== mediaId) });
    await refresh();
  }

  return (
    <section class="page">
      <header class="page-header">
        <div>
          <h2>Albums</h2>
          <p class="muted">Personal collections. Albums organise the shared library; they do not hide media.</p>
        </div>
      </header>

      <form class="inline-form" onSubmit={create}>
        <label class="field grow">
          <span>New album</span>
          <input value={title} maxLength={200} onInput={(event) => setTitle((event.target as HTMLInputElement).value)} />
        </label>
        <button class="button primary" type="submit">
          Create
        </button>
      </form>

      {status === 'error' ? <div class="notice error">Albums could not be loaded.</div> : null}
      {status === 'loading' ? <p class="muted">Loading albums…</p> : null}
      {status === 'ready' && albums.length === 0 ? (
        <div class="notice">
          <h3>No albums yet</h3>
          <p>Create one above, then open media and add it to an album from the API-driven album view.</p>
        </div>
      ) : null}

      <ul class="album-list">
        {albums.map((album) => (
          <li key={album.id}>
            <button class="album-card" type="button" onClick={() => void open(album)}>
              <span class="album-title">{album.title}</span>
              <span class="muted small">
                {album.itemCount} item{album.itemCount === 1 ? '' : 's'} · {formatDate(album.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selected ? (
        <section class="panel">
          <header class="page-header">
            <h3>{selected.album.title}</h3>
            <button class="button ghost" type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </header>
          {selected.items.length === 0 ? (
            <p class="muted">This album is empty.</p>
          ) : (
            <ul class="grid">
              {selected.items.map((item, index) => (
                <li key={item.id}>
                  <div class="tile static">
                    <button class="tile-open" type="button" onClick={() => setViewerIndex(index)}>
                      <img src={item.thumbnailUrl} alt={item.fileName} loading="lazy" width={400} height={400} />
                    </button>
                    <button class="tile-remove" type="button" onClick={() => void removeItem(item.id)}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {viewerIndex !== null && selected?.items[viewerIndex] ? (
        <Viewer
          items={selected.items}
          index={viewerIndex}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onFavorite={(_index, _value) => void refresh()}
        />
      ) : null}
    </section>
  );
}
