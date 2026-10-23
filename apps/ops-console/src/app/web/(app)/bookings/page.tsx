import {redirect} from 'next/navigation';
import {webRoutes} from '@/lib/web/routes';

/**
 * Owner 2026-10-23: the Web App is a messenger — Book, Bookings and Secure Pro
 * were removed from it (they stay in the Bravo app). Old links and bookmarks
 * land on Chats instead of a 404.
 */
export default function Removed(): never {
  redirect(webRoutes.chats);
}
