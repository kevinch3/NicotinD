import type { Meta, StoryObj } from '@storybook/angular';
import { PasswordFieldComponent } from './password-field.component';

const meta: Meta<PasswordFieldComponent> = {
  title: 'Components/PasswordField',
  component: PasswordFieldComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A password input with a show/hide toggle. Exists so the reveal affordance, its `aria` wiring and its autocomplete hints are identical on login, registration, setup and every credential field in Extensions.',
      },
    },
  },
  args: { placeholder: 'Password', autocomplete: 'current-password' },
};

export default meta;
type Story = StoryObj<PasswordFieldComponent>;

export const Default: Story = {};
export const Required: Story = { args: { required: true } };
export const NewPassword: Story = {
  args: { autocomplete: 'new-password', placeholder: 'Choose a password' },
};
export const WithTestId: Story = { args: { testId: 'login-password' } };
