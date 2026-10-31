import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { AdminPage } from './pages/Admin';
import { BriefsPage } from './pages/Briefs';
import { BriefWorkspace } from './pages/BriefWorkspace';
import { HomePage } from './pages/Home';
import { LoginPage, OnboardingPage } from './pages/Auth';
import { ReviewsPage } from './pages/Reviews';
import { ShowProfilePage } from './pages/ShowProfile';
import { SourceDetailPage } from './pages/SourceDetail';
import { SourcesPage } from './pages/Sources';

const root = createRootRoute({ component: () => <Outlet /> });
const login = createRoute({ getParentRoute: () => root, path: '/login', component: LoginPage });
const onboarding = createRoute({ getParentRoute: () => root, path: '/onboarding', component: OnboardingPage });
const app = createRoute({ getParentRoute: () => root, id: 'app', component: Layout });

const home = createRoute({ getParentRoute: () => app, path: '/', component: HomePage });
const admin = createRoute({ getParentRoute: () => app, path: '/admin', component: AdminPage });
const showProfile = createRoute({ getParentRoute: () => app, path: '/shows/$showId', component: ShowProfilePage });
const sources = createRoute({ getParentRoute: () => app, path: '/sources', component: SourcesPage });
const sourceDetail = createRoute({ getParentRoute: () => app, path: '/sources/$sourceId', component: SourceDetailPage });
const briefs = createRoute({ getParentRoute: () => app, path: '/briefs', component: BriefsPage });
const brief = createRoute({ getParentRoute: () => app, path: '/briefs/$briefId', component: BriefWorkspace });
const reviews = createRoute({ getParentRoute: () => app, path: '/reviews', component: ReviewsPage });

const routeTree = root.addChildren([
  login, onboarding,
  app.addChildren([home, admin, showProfile, sources, sourceDetail, briefs, brief, reviews]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
