import { useEffect, useState } from 'preact/hooks';
import { api, type User } from './api.ts';
import { activateOfflineAccount, applyUpdate, clearAllOfflineData, onUpdateReady } from './pwa.ts';
import { Gallery } from './gallery.tsx';
import { AlbumsPage } from './albums.tsx';
import { SettingsPage } from './settings.tsx';
import { AdminPage } from './admin.tsx';
import { LoginPage } from './login.tsx';

const NAV = [
  { path: '/', label: 'Home' },
  { path: '/photos', label: 'Photos' },
  { path: '/videos', label: 'Videos' },
  { path: '/360', label: '360° Media' },
  { path: '/albums', label: 'Albums' },
  { path: '/favorites', label: 'Favorites' },
  { path: '/history', label: 'Recently viewed' },
  { path: '/settings', label: 'Settings' },
];

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePathname(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function App() {
  const path = usePathname();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [updateReady, setUpdateReady] = useState(false);
  const [sessionCheck, setSessionCheck] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!online) return () => { cancelled = true; };
    api
      .session()
      .then((result) => {
        if (!cancelled) setUser(result.user);
      })
      .catch(() => {
        // An unreachable network is not an authentication failure: keep the
        // offline notice visible instead of showing a misleading login form.
        if (!cancelled) setUser(navigator.onLine ? null : undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [online, sessionCheck]);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      setSessionCheck((value) => value + 1);
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => onUpdateReady(() => setUpdateReady(true)), []);

  useEffect(() => {
    if (user) void activateOfflineAccount(user.id);
  }, [user?.id]);

  async function logout() {
    await clearAllOfflineData();
    try {
      await api.logout();
    } finally {
      setUser(null);
      navigate('/');
    }
  }

  if (user === undefined) {
    if (!online) {
      return (
        <main class="login">
          <section class="login-card">
            <div class="brand brand-large">
              <span class="brand-mark" aria-hidden="true">360</span>
              <div>
                <h1>You’re offline</h1>
                <p>NiX 360 Media needs a connection to verify your session.</p>
              </div>
            </div>
            <p class="muted">Thumbnails you explicitly kept offline may still appear once the library can be opened online. Videos and originals are never available offline.</p>
            <button class="button primary" type="button" onClick={() => setSessionCheck((value) => value + 1)}>
              Try again
            </button>
          </section>
        </main>
      );
    }
    return <div class="boot">Loading NiX 360 Media…</div>;
  }
  if (user === null) return <LoginPage onSuccess={setUser} />;

  return (
    <div class="shell">
      {!online ? (
        <div class="app-banner offline" role="status">
          Offline — cached thumbnails may still appear. Playback, scanning and changes need a connection.
        </div>
      ) : null}
      {updateReady ? (
        <div class="app-banner update" role="status">
          A new NiX Media version is ready.
          <button class="button small" type="button" onClick={applyUpdate}>
            Reload to update
          </button>
        </div>
      ) : null}
      <header class="topbar">
        <a
          class="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate('/');
          }}
        >
          <span class="brand-mark" aria-hidden="true">
            360
          </span>
          <span>NiX Media</span>
        </a>
        <div class="topbar-user">
          <span class="muted small">{user.displayName}</span>
          <button class="button ghost small" type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>

      <nav class="nav" aria-label="Library sections">
        {NAV.map((item) => (
          <a
            key={item.path}
            href={item.path}
            class={path === item.path ? 'nav-link active' : 'nav-link'}
            aria-current={path === item.path ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(item.path);
            }}
          >
            {item.label}
          </a>
        ))}
        {user.role === 'admin' ? (
          <a
            href="/admin"
            class={path === '/admin' ? 'nav-link active' : 'nav-link'}
            aria-current={path === '/admin' ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate('/admin');
            }}
          >
            Admin
          </a>
        ) : null}
      </nav>

      <main class="content">{renderPage(path, user, logout)}</main>
    </div>
  );
}

function renderPage(path: string, user: User, logout: () => Promise<void>) {
  if (path === '/') {
    return (
      <Gallery
        title="Home"
        subtitle="Everything indexed in your shared library, newest first."
        emptyTitle="Your library is empty"
        emptyHint="An administrator can start a scan from the Admin page after media roots are configured."
        canEdit={user.role === 'admin'}
      />
    );
  }
  if (path === '/photos') {
    return (
      <Gallery
        title="Photos"
        filter={{ type: 'photo' }}
        navigable
        emptyTitle="No photos indexed yet"
        emptyHint="Run a library scan from the Admin page, or check that the photo root is mounted."
        canEdit={user.role === 'admin'}
      />
    );
  }
  if (path === '/videos') {
    return (
      <Gallery
        title="Videos"
        filter={{ type: 'video' }}
        emptyTitle="No videos indexed yet"
        emptyHint="Videos appear after a scan; files are preserved even when a browser-compatible rendition is not ready."
        canEdit={user.role === 'admin'}
      />
    );
  }
  if (path === '/360') {
    return (
      <Gallery
        title="360° Media"
        subtitle="Files classified as equirectangular from their own metadata."
        filter={{ projection: 'equirectangular' }}
        emptyTitle="No verified 360° media yet"
        emptyHint="A 2:1 image is only a hint. Items appear here once projection metadata or an explicit override confirms a sphere."
        canEdit={user.role === 'admin'}
      />
    );
  }
  if (path === '/albums') return <AlbumsPage />;
  if (path === '/favorites') {
    return (
      <Gallery
        title="Favorites"
        filter={{ favorite: true }}
        emptyTitle="No favorites yet"
        emptyHint="Open any item and choose Favorite to keep it here."
        canEdit={user.role === 'admin'}
      />
    );
  }
  if (path === '/history') {
    return (
      <Gallery
        title="Recently viewed"
        subtitle="Ordered by when you last opened each item."
        filter={{ history: true }}
        emptyTitle="Nothing viewed yet"
        emptyHint="Items you open will appear here."
        canEdit={user.role === 'admin'}
      />
    );
  }
  if (path === '/settings') return <SettingsPage user={user} onLogout={() => void logout()} onNavigate={navigate} />;
  if (path === '/admin') {
    return user.role === 'admin' ? (
      <AdminPage currentUser={user} />
    ) : (
      <section class="notice error">Administrator access is required.</section>
    );
  }
  return (
    <section class="notice">
      <h3>Page not found</h3>
      <p>That address does not match a library view.</p>
    </section>
  );
}
