# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: TC-105.spec.ts >> TC-105: Login page shows email/password fields, Login button and links
- Location: scripts/TC-105.spec.ts:15:1

# Error details

```
Error: E1

expect(locator).toHaveAttribute(expected) failed

Locator: locator('input[name="email"]')
Expected: "Please Enter Your Email"
Error: strict mode violation: locator('input[name="email"]') resolved to 2 elements:
    1) <input value="" type="text" name="email" autocomplete="on" class="input-text" placeholder="Please Enter Your Email"/> aka getByRole('main').getByRole('textbox', { name: 'Please Enter Your Email' })
    2) <input value="" type="text" name="email" autocomplete="on" class="input-text" placeholder="Please Enter Your Email"/> aka getByRole('contentinfo').getByRole('textbox', { name: 'Please Enter Your Email' })

Call log:
  - E1 locator('input[name="email"]') with timeout 5000ms
  - waiting for locator('input[name="email"]')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - generic [ref=e7]:
      - generic [ref=e8]:
        - generic [ref=e9]: 
        - text: Free Shipping
      - generic [ref=e10]:
        - generic [ref=e11]: 
        - text: Payment Methods
      - generic [ref=e12]:
        - generic [ref=e13]: 
        - text: Call us 951-999-9999
      - text: 
    - generic [ref=e15]:
      - generic [ref=e17]:
        - button "open the menu" [ref=e18] [cursor=pointer]:
          - generic [aria-hidden] [ref=e20]: 
        - link [ref=e21] [cursor=pointer]:
          - /url: /
          - heading "MERN Store" [level=1] [ref=e22]
      - combobox [ref=e24]:
        - textbox "Search Products" [ref=e25]
      - text: 
      - navigation [ref=e27]:
        - button "your cart is empty" [ref=e28] [cursor=pointer]
        - list [ref=e34]:
          - listitem [ref=e35]:
            - link "Brands " [ref=e36] [cursor=pointer]:
              - /url: "#"
              - text: Brands
              - generic [ref=e37]: 
          - listitem [ref=e38]:
            - link "Shop" [ref=e39] [cursor=pointer]:
              - /url: /shop
          - listitem [ref=e40]:
            - link "Welcome! " [ref=e41] [cursor=pointer]:
              - /url: "#"
              - text: Welcome!
              - generic [ref=e42]: 
  - main [ref=e43]:
    - generic [ref=e46]:
      - heading "Login" [level=2] [ref=e47]
      - separator [ref=e48]
      - generic [ref=e49]:
        - generic [ref=e50]:
          - generic [ref=e51]:
            - generic [ref=e53]:
              - generic [ref=e54]: Email Address
              - textbox "Please Enter Your Email" [ref=e56]
            - generic [ref=e58]:
              - generic [ref=e59]: Password
              - textbox "Please Enter Your Password" [ref=e61]
          - generic [ref=e63] [cursor=pointer]:
            - link "Login with Google" [ref=e64]:
              - /url: http://localhost:3000/api/auth/google
            - link "Login with Facebook" [ref=e71]:
              - /url: http://localhost:3000/api/auth/facebook
        - separator [ref=e75]
        - generic [ref=e76]:
          - generic [ref=e77]:
            - button "Login" [ref=e78] [cursor=pointer]
            - button "Create an account" [ref=e79] [cursor=pointer]
          - link "Forgot Password?" [ref=e80] [cursor=pointer]:
            - /url: /forgot-password
  - contentinfo [ref=e81]:
    - generic [ref=e82]:
      - generic [ref=e83]:
        - generic [ref=e84]:
          - heading "Customer Service" [level=3] [ref=e86]
          - list [ref=e88]:
            - listitem [ref=e89]:
              - link "Contact Us" [ref=e90] [cursor=pointer]:
                - /url: /contact
            - listitem [ref=e91]:
              - link "Sell With Us" [ref=e92] [cursor=pointer]:
                - /url: /sell
            - listitem [ref=e93]:
              - link "Shipping" [ref=e94] [cursor=pointer]:
                - /url: /shipping
        - generic [ref=e95]:
          - heading "Links" [level=3] [ref=e97]
          - list [ref=e99]:
            - listitem [ref=e100]:
              - link "Contact Us" [ref=e101] [cursor=pointer]:
                - /url: /contact
            - listitem [ref=e102]:
              - link "Sell With Us" [ref=e103] [cursor=pointer]:
                - /url: /sell
            - listitem [ref=e104]:
              - link "Shipping" [ref=e105] [cursor=pointer]:
                - /url: /shipping
        - generic [ref=e107]:
          - heading "Newsletter" [level=3] [ref=e108]
          - generic [ref=e109]:
            - paragraph [ref=e110]: Sign Up for Our Newsletter
            - generic [ref=e114]:
              - textbox "Please Enter Your Email" [ref=e115]
              - button "Subscribe" [ref=e116] [cursor=pointer]
      - generic [ref=e117]: © 2026 MERN Store
      - list [ref=e119]:
        - listitem [ref=e120]:
          - link [ref=e121] [cursor=pointer]:
            - /url: /#facebook
        - listitem [ref=e123]:
          - link [ref=e124] [cursor=pointer]:
            - /url: /#instagram
        - listitem [ref=e126]:
          - link [ref=e127] [cursor=pointer]:
            - /url: /#pinterest
        - listitem [ref=e129]:
          - link [ref=e130] [cursor=pointer]:
            - /url: /#twitter
```

# Test source

```ts
  1  | // TC-105: Login page shows email/password fields, Login button and links
  2  | // Generated by agentic-web-testing from testcases.json.
  3  | import { expect, fixtures, loggedInPage, loginViaApi, loginViaUi, test, uniq } from './_helpers.js';
  4  | 
  5  | // @locked-expected TC-105: generated from testcases.json. Do not edit.
  6  | const EXPECTED = {
  7  |   E1: { description: 'Email input with placeholder shown', value: 'Please Enter Your Email' },
  8  |   E2: { description: 'Password input with placeholder shown', value: 'Please Enter Your Password' },
  9  |   E3: { description: 'Login submit button shown', value: 'Login' },
  10 |   E4: { description: 'Create an account link shown', value: 'Create an account' },
  11 |   E5: { description: 'Forgot Password? link shown', value: 'Forgot Password?' },
  12 | } as const;
  13 | // @end-locked-expected
  14 | 
  15 | test('TC-105: Login page shows email/password fields, Login button and links', async ({ page, api }) => {
  16 |   await page.goto('/login');
  17 | 
  18 |   const emailInput = page.locator('input[name="email"]');
  19 |   const passwordInput = page.locator('input[name="password"]');
  20 | 
> 21 |   await expect(emailInput, 'E1').toHaveAttribute('placeholder', EXPECTED.E1.value);
     |                                  ^ Error: E1
  22 |   await expect(passwordInput, 'E2').toHaveAttribute('placeholder', EXPECTED.E2.value);
  23 | 
  24 |   const form = page.locator('form');
  25 |   const submitButton = form.locator('button[type="submit"]').first();
  26 |   await expect(submitButton, 'E3').toHaveText(EXPECTED.E3.value);
  27 | 
  28 |   const registerButton = form.locator('button.custom-btn-link').first();
  29 |   await expect(registerButton, 'E4').toHaveText(EXPECTED.E4.value);
  30 | 
  31 |   const forgotLink = page.locator('a.forgot-password-link').first();
  32 |   await expect(forgotLink, 'E5').toHaveText(EXPECTED.E5.value);
  33 | });
  34 | 
```