'use client';

/**
 * The web app's three messenger pages (Chats, Contacts, Groups) are one chat
 * workspace opened on a different tab. Kept in one place so the directory
 * (exact phone-number search) is the same on all three.
 */
import {useMemo} from 'react';
import {useWeb} from '@/components/web/WebShell';
import {ChatWorkspace, type ChatTab} from '@/features/messenger/ChatWorkspace';
import {webChatDirectory} from '@/lib/web/directory';

export function WebMessenger({view}: {view: ChatTab}) {
  const {me} = useWeb();
  const directory = useMemo(() => webChatDirectory(me.user.id), [me.user.id]);
  return (
    <div className="web-chat-page">
      <ChatWorkspace directory={directory} initialTab={view} key={view}/>
    </div>
  );
}
