import type { Meta, StoryObj } from '@storybook/angular';
import { PasswordFieldComponent } from './password-field.component';

const meta: Meta<PasswordFieldComponent> = {
  title: 'Components/PasswordField',
  component: PasswordFieldComponent,
  tags: ['autodocs'],
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
