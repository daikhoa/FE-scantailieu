import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthScreen } from './AuthScreen';

describe('AuthScreen', () => {
  it('submits email/password registration and allows retry after an API error', async () => {
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Email đã được đăng ký.'))
      .mockResolvedValue(undefined);
    render(<AuthScreen onAuthenticate={authenticate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'correct password' } });
    fireEvent.change(screen.getByLabelText('Nhập lại mật khẩu'), {
      target: { value: 'different password' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Đăng ký tài khoản' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mật khẩu nhập lại chưa khớp');
    expect(authenticate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Nhập lại mật khẩu'), {
      target: { value: 'correct password' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Đăng ký tài khoản' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email đã được đăng ký.');
    fireEvent.submit(screen.getByRole('form', { name: 'Đăng ký tài khoản' }));
    await waitFor(() => {
      expect(authenticate).toHaveBeenCalledTimes(2);
    });
    expect(authenticate).toHaveBeenLastCalledWith(
      'register',
      'test@example.com',
      'correct password',
    );
  });
});
