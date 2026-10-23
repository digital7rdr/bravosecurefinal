'use client';

/**
 * Chats (Bravo Web App home): the encrypted Messenger, full page, like a
 * desktop messenger. Accounts with the Bravo app link this browser to their
 * phone with a QR code (WhatsApp Web style) and see their chats, groups and
 * contacts here; accounts without a phone use this browser as their own
 * device. Text only for now.
 */
import {WebMessenger} from '@/components/web/WebMessenger';

export default function WebChats() {
  return <WebMessenger view="chats"/>;
}
