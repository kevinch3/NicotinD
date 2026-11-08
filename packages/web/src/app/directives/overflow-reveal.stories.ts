import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { OverflowRevealDirective } from './overflow-reveal.directive';

const LONG = 'Muriendo De Envidia Featuring A Guest Whose Name Will Never Fit';

const row = (name: string, mode = '', dir = 'ltr') => `
  <div style="width: 240px" dir="${dir}">
    <button type="button" class="w-full text-left px-3 py-2 rounded-lg hover:bg-theme-hover">
      <p class="text-sm text-theme-primary truncate" appOverflowReveal${mode ? `="${mode}"` : ''}>${name}</p>
    </button>
  </div>`;

/**
 * `appOverflowReveal` on a truncated name (#1665). A name that fits never moves;
 * one that does not scrolls its own box at a constant speed until the last
 * character shows. List rows scroll on hover or keyboard focus here (and once,
 * on their own, when a touch row settles in view); the playing title loops.
 * Under *Emulate CSS prefers-reduced-motion* nothing moves and a tap wraps the
 * name instead. docs/design-patterns.md "Names are never unreadably truncated".
 */
const meta: Meta = {
  title: 'Patterns/Overflow reveal',
  decorators: [moduleMetadata({ imports: [OverflowRevealDirective] })],
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/** `I am 34` fits: plain static text, no title, no motion. */
export const NameThatFits: Story = { render: () => ({ template: row('I am 34') }) };

/** Hover or tab to the row: it scrolls to the end, holds, and comes back. */
export const LongNameInAList: Story = { render: () => ({ template: row(LONG) }) };

/** The playing title (`="always"`) loops for as long as it is on screen. */
export const PlayingTitle: Story = { render: () => ({ template: row(LONG, 'always') }) };

/** A right-to-left name scrolls the other way. */
export const RightToLeft: Story = {
  render: () => ({
    template: row('מוריינדו דה אנבידיה עם אורח ששמו לעולם לא ייכנס בשורה', 'always', 'rtl'),
  }),
};
