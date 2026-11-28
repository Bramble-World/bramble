import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OpenInApp } from './open-in-app';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('OpenInApp', () => {
  it("hands the note in the fragment to the app's own scheme", () => {
    window.history.replaceState(null, '', '/open/story#my%20ex%20texted%20me');
    render(<OpenInApp path="open/story" />);
    expect(screen.getByRole('link', { name: 'open in bramble' })).toHaveAttribute(
      'href',
      'bramble://open/story#my%20ex%20texted%20me'
    );
  });

  it('opens the desk when there is no note', () => {
    window.history.replaceState(null, '', '/open');
    render(<OpenInApp path="open" />);
    expect(screen.getByRole('link', { name: 'open in bramble' })).toHaveAttribute(
      'href',
      'bramble://open'
    );
  });
});
