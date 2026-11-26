import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InviteCard } from './invite-card';

const base = {
  inviterFirstName: 'Maya',
  code: 'ABCDEF',
  appStoreUrl: 'https://apps.apple.com/app/id1',
};

describe('InviteCard', () => {
  it('shows an open invite: who, the code, how to use it, and the store', () => {
    render(<InviteCard {...base} state="open" />);
    expect(screen.getByText('maya invited you to a story together.')).toBeInTheDocument();
    expect(screen.getByText('ABCDEF')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'copy code' })).toBeInTheDocument();
    expect(screen.getByText(/new to bramble\? open it and tap/)).toBeInTheDocument();
    expect(screen.getByText(/already playing\? go to settings/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'get bramble on the app store' })).toHaveAttribute(
      'href',
      base.appStoreUrl
    );
  });

  it('hides the store button when there is no store link', () => {
    render(<InviteCard {...base} appStoreUrl={null} state="open" />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says a used or a run-out invite in a line, without the code', () => {
    const { unmount } = render(<InviteCard {...base} state="accepted" />);
    expect(screen.getByText("maya's invite has already been used.")).toBeInTheDocument();
    expect(screen.queryByText('ABCDEF')).toBeNull();
    unmount();
    render(<InviteCard {...base} state="expired" />);
    expect(
      screen.getByText("maya's invite has run out. ask them to send a new one.")
    ).toBeInTheDocument();
    expect(screen.queryByText('ABCDEF')).toBeNull();
  });
});
