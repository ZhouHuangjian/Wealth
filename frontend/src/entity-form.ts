/** Apply this form's current defaults after mount, including StrictMode replay.
 * Call only at mount: option loading and user edits must never reset a draft.
 */
export function initializeMountedEntityForm(form: { resetFields: () => void }) {
  form.resetFields();
}
