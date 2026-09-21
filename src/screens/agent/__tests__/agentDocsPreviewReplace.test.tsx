/**
 * B-823 (founder, 2026-09-08) — "when people upload documents for verification
 * they should be able to see their docs so they can verify it is the correct
 * docs, and can delete if they uploaded a different doc."
 *
 * Before the fix a DONE row was `disabled={isDone || isBusy}`, so an uploaded
 * slot was inert: the file could neither be seen nor changed. RED pre-fix:
 * T1, T2, T4, T5, T6, T7 (nothing opens, so no sheet, no testIDs at all).
 */
import React from 'react';
import {Linking} from 'react-native';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';

type AlertButton = {text?: string; style?: string; onPress?: () => void};

const mockGetMe = jest.fn();
const mockUploadFile = jest.fn();
const mockUploadDoc = jest.fn();
const mockDeleteDoc = jest.fn();
const mockSubmit = jest.fn();
const mockPick = jest.fn();
const mockAlert = jest.fn();
const order: string[] = [];

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    replace: jest.fn(),
    navigate: jest.fn(),
    goBack: jest.fn(),
    canGoBack: () => false,
    getState: () => ({routeNames: ['AgentDocsUpload']}),
  }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(() => cb(), [cb]);
  },
}));

jest.mock('@services/api', () => ({
  agentApi: {
    getMe:      (...a: unknown[]) => mockGetMe(...a),
    uploadFile: (...a: unknown[]) => { order.push('uploadFile'); return mockUploadFile(...a); },
    uploadDoc:  (...a: unknown[]) => { order.push('uploadDoc');  return mockUploadDoc(...a); },
    deleteDoc:  (...a: unknown[]) => { order.push('deleteDoc');  return mockDeleteDoc(...a); },
    submit:     (...a: unknown[]) => mockSubmit(...a),
  },
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...a: unknown[]) => mockPick(...a),
}));

jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));

jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: {signOut: () => void}) => unknown) => sel({signOut: jest.fn()}),
}));

import AgentDocsUploadScreen from '../AgentDocsUploadScreen';

const IMG = 'http://host:3001/uploads/u1/1757322000-passport.jpg';
const PDF = 'http://host:3001/uploads/u1/1757322000-insurance%20cover.pdf';

const doneDoc = (over: Record<string, unknown> = {}) => ({
  id: 'd1', slot: 'passport', required: true, title: 'Passport / National ID',
  state: 'done', file_url: IMG, uploaded_at: '2026-09-08T09:00:00.000Z',
  reviewed_at: null, ...over,
});

async function mount(opts: {documents: unknown[]; status?: string}) {
  mockGetMe.mockResolvedValue({
    data: {agent: {status: opts.status ?? 'DOCS_PENDING'}, documents: opts.documents},
  });
  const u = render(<AgentDocsUploadScreen />);
  // Fix-independent anchor: the DONE badge already rendered before B-823.
  await waitFor(() => expect(u.queryAllByText('DONE').length).toBe(opts.documents.length));
  return u;
}

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  mockUploadFile.mockResolvedValue('http://host:3001/uploads/u1/2-new.pdf');
  mockUploadDoc.mockResolvedValue({data: {}});
  mockDeleteDoc.mockResolvedValue({data: {}});
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
});

describe('B-823 — see the document you uploaded', () => {
  it('T1: a DONE row is pressable and opens the document sheet', async () => {
    const u = await mount({documents: [doneDoc()]});
    // The founder's complaint was "I can't change" — an openable row has to
    // LOOK openable, so the affordance is part of the fix, not decoration.
    expect(u.getByTestId('agent-doc-chevron-passport')).toBeTruthy();
    expect(u.queryByTestId('agent-doc-chevron-insurance')).toBeNull();

    fireEvent.press(u.getByTestId('agent-doc-row-passport'));
    expect(u.getByTestId('agent-doc-sheet')).toBeTruthy();
    // Pressing a DONE row must NOT re-open the picker.
    expect(mockPick).not.toHaveBeenCalled();
  });

  it('T2: an image previews inline; a PDF offers Open document', async () => {
    const u = await mount({documents: [doneDoc()]});
    fireEvent.press(u.getByTestId('agent-doc-row-passport'));
    expect(u.getByTestId('agent-doc-preview-image').props.source).toEqual({uri: IMG});

    const v = await mount({documents: [doneDoc({file_url: PDF})]});
    expect(v.queryByTestId('agent-doc-preview-image')).toBeNull();
    fireEvent.press(v.getByTestId('agent-doc-row-passport'));
    fireEvent.press(v.getByTestId('agent-doc-open'));
    expect(Linking.openURL).toHaveBeenCalledWith(PDF);
  });

  it('T3: the sheet dates the upload in UTC', async () => {
    const u = await mount({documents: [doneDoc()]});
    fireEvent.press(u.getByTestId('agent-doc-row-passport'));
    expect(u.getByText('Uploaded Tue 08 Sep')).toBeTruthy();
  });

  it('T4: Remove confirms, deletes once, refetches and closes', async () => {
    const u = await mount({documents: [doneDoc()]});
    fireEvent.press(u.getByTestId('agent-doc-row-passport'));

    // Rapid double press — the synchronous ref guard must swallow the second.
    fireEvent.press(u.getByTestId('agent-doc-remove'));
    fireEvent.press(u.getByTestId('agent-doc-remove'));
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][0]).toBe('Remove this document?');

    mockGetMe.mockResolvedValue({data: {agent: {status: 'DOCS_PENDING'}, documents: []}});
    const buttons = mockAlert.mock.calls[0][2] as AlertButton[];
    await act(async () => { buttons.find(b => b.style === 'destructive')?.onPress?.(); });

    expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    expect(mockDeleteDoc).toHaveBeenCalledWith('passport');
    expect(mockGetMe).toHaveBeenCalledTimes(2);
    expect(u.queryByTestId('agent-doc-sheet')).toBeNull();
  });

  it('T5: Replace picks FIRST, then deletes, then uploads — in that order', async () => {
    const u = await mount({documents: [doneDoc()]});
    fireEvent.press(u.getByTestId('agent-doc-row-passport'));

    mockPick.mockResolvedValue({canceled: true});
    await act(async () => { fireEvent.press(u.getByTestId('agent-doc-replace')); });
    expect(mockPick).toHaveBeenCalledTimes(1);
    expect(order).toEqual([]);

    fireEvent.press(u.getByTestId('agent-doc-row-passport'));
    mockPick.mockResolvedValue({
      canceled: false,
      assets: [{uri: 'file:///tmp/new.pdf', name: 'new.pdf', mimeType: 'application/pdf'}],
    });
    await act(async () => { fireEvent.press(u.getByTestId('agent-doc-replace')); });

    expect(order).toEqual(['deleteDoc', 'uploadFile', 'uploadDoc']);
    expect(mockUploadDoc).toHaveBeenCalledWith(expect.objectContaining({slot: 'passport'}));
  });

  it('T6: a verified officer sees the preview but no mutation buttons', async () => {
    const u = await mount({documents: [doneDoc()], status: 'ACTIVE'});
    fireEvent.press(u.getByTestId('agent-doc-row-passport'));
    expect(u.getByTestId('agent-doc-sheet')).toBeTruthy();
    expect(u.queryByTestId('agent-doc-replace')).toBeNull();
    expect(u.queryByTestId('agent-doc-remove')).toBeNull();
    expect(u.getByText('Verified documents are changed through Bravo ops.')).toBeTruthy();
  });

  it('T7: a server document_locked refusal is spelled out in plain English', async () => {
    const u = await mount({documents: [doneDoc()]});
    fireEvent.press(u.getByTestId('agent-doc-row-passport'));
    mockDeleteDoc.mockRejectedValue({response: {data: {message: 'document_locked'}}});

    fireEvent.press(u.getByTestId('agent-doc-remove'));
    const buttons = mockAlert.mock.calls[0][2] as AlertButton[];
    await act(async () => { buttons.find(b => b.style === 'destructive')?.onPress?.(); });

    expect(mockAlert).toHaveBeenCalledWith(
      'Could not remove',
      'This document has been verified. Contact Bravo ops to replace it.',
    );
  });
});
