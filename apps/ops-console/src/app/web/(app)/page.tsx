'use client';

/**
 * Chats (Bravo Web App home): the encrypted Messenger, full page, like a
 * desktop messenger. Same Signal sessions, Sealed Sender and relay as the app;
 * this browser is its own device with its own keys and its own vault, so it
 * receives messages sent after it was set up. Text only for now.
 */
import {useMemo} from 'react';
import {useWeb} from '@/components/web/WebShell';
import {ChatWorkspace} from '@/features/messenger/ChatWorkspace';
import {webChatDirectory} from '@/lib/web/directory';

export default function WebChats() {
  const {me} = useWeb();
  const directory = useMemo(() => webChatDirectory(me.user.id), [me.user.id]);
  return (
    <div className="web-chat-page">
      <ChatWorkspace directory={directory}/>
    </div>
  );
}
