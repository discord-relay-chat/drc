/* globals fetch, monaco, Blob */

'use strict';

const saveButton = document.getElementById('save');
let keyComponent, name;

const userOptions = {
  allowSaveWithLintErrors: false
};

function saveBlobLocally (blob, filename, complete) {
  const tempA = document.createElement('a');
  const urlObj = URL.createObjectURL(blob);

  // adapted from https://stackoverflow.com/a/30832210
  tempA.href = urlObj;
  tempA.style.display = 'none';
  tempA.download = filename;
  document.body.appendChild(tempA);
  tempA.click();
  setTimeout(() => {
    document.body.removeChild(tempA);
    window.URL.revokeObjectURL(urlObj);
    if (complete) {
      complete();
    }
  });
}

function download () {
  const blob = new Blob([monaco.editor.getEditors()[0].getValue()], { type: 'text/javascript' });
  const dateISO = (new Date()).toISOString().replaceAll(':', '').replaceAll('.', '');
  saveBlobLocally(blob, `${name}.${dateISO}.js`);
}

function setStatusText (text) {
  saveButton.innerText = `${text} Save`;
  saveButton.removeEventListener('click', clickListener);
  setTimeout(() => {
    saveButton.innerText = '💾 Save';
    saveButton.disabled = false;
    saveButton.addEventListener('click', clickListener);
  }, 3000);
}

function clickListener () {
  saveButton.disabled = true;
  const uri = `${window.location.pathname.replace('/', '')}/${keyComponent}/${name}`;
  const body = monaco.editor.getEditors()[0].getValue();
  fetch(uri, { method: 'PATCH', body })
    .then(async (res) => {
      if (res.ok) {
        const { linted, formatted } = await res.json();
        const [{ errorCount, warningCount, fatalErrorCount }] = linted;

        if (errorCount > 0 || warningCount > 0 || fatalErrorCount > 0) {
          const lintWindow = window.open('about:blank', '', '_blank,width=1024,height=640');
          lintWindow.document.write(formatted.html);
        }

        if ((errorCount > 0 || fatalErrorCount > 0) && !userOptions.allowSaveWithLintErrors) {
          setStatusText('❌');
          return;
        }

        fetch(uri, {
          method: 'PUT',
          body
        })
          .then(() => {
            setStatusText('✔️');
          })
          .catch((err) => {
            setStatusText('❌');
            console.error('fetch error', err);
          });
      }
    });
}

// eslint-disable-next-line no-unused-vars
function drcEditorInit (n, kc, readOnly) {
  name = n;
  keyComponent = kc;
  const editorEle = document.getElementById('editor');
  const { sourceStrBase64, theme, fontSize } = editorEle.dataset;
  const downloadBound = download.bind(null, name);
  let updateStateHandle;

  async function updateState () {
    const stateRes = await fetch(`${window.location.pathname.replace('/', '')}/${keyComponent}/${name}`);
    if (stateRes.ok) {
      document.getElementById('sidebar_state').innerText = JSON.stringify(await stateRes.json(), null, 2);
      return true;
    }
    return false;
  }

  require.config({ paths: { vs: '/vendored/monaco' } });
  require(['vs/editor/editor.main'], function () {
    let editor; // eslint-disable-line prefer-const

    async function toggleStateSidebar () {
      const sidebar = document.getElementById('sidebar');
      const showStateBut = document.getElementById('show_state');
      if (sidebar.style.display === 'none' || sidebar.style.display === '') {
        if (await updateState()) {
          sidebar.style.display = 'inline-block';
          editorEle.setAttribute('style', `right: ${sidebar.offsetWidth}px`);
          showStateBut.innerText = '🙈 Hide state';
          editor.layout();
          updateStateHandle = setInterval(updateState, 1000);
        }
      } else {
        sidebar.style.display = 'none';
        editorEle.setAttribute('style', 'right: 0');
        showStateBut.innerText = '🧠 Show state';
        editor.layout();
        clearInterval(updateStateHandle);
      }
    }

    editor = monaco.editor.create(editorEle, {
      value: atob(sourceStrBase64),
      language: 'javascript',
      automaticLayout: true,
      minimap: {
        enabled: false
      },
      padding: {
        top: 8
      },
      theme,
      fontSize,
      readOnly
    });

    editor.addAction({
      id: 'save',
      label: 'Save',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS
      ],
      contextMenuGroupId: 'discordrc',
      contextMenuOrder: 1,
      run: clickListener.bind(null, keyComponent, name)
    });

    editor.addAction({
      id: 'download',
      label: 'Download',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD
      ],
      contextMenuGroupId: 'discordrc',
      contextMenuOrder: 2,
      run: downloadBound
    });

    editor.addAction({
      id: 'toggle_state',
      label: 'Toggle State sidebar',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS
      ],
      contextMenuGroupId: 'discordrc',
      contextMenuOrder: 3,
      run: toggleStateSidebar
    });

    const themeService = require('vs/editor/standalone/browser/standaloneThemeService');
    const themeNames = Object.keys(themeService).filter((n) => n.indexOf('_THEME_NAME') !== -1).map((kn) => themeService[kn]);
    const themeSelector = document.getElementById('pick_theme');
    themeNames.forEach((tn) => {
      const opt = document.createElement('option');
      opt.innerText = opt.value = tn;
      opt.id = `pick_theme_option__${tn}`;
      themeSelector.appendChild(opt);
    });

    document.getElementById(`pick_theme_option__${theme}`).selected = true;
    document.getElementById('pick_theme').addEventListener('change',
      (e) => monaco.editor.setTheme(e.target.selectedOptions[0].value));

    saveButton?.addEventListener('click', clickListener);

    document.getElementById('backup').addEventListener('click', downloadBound);

    const fsBox = document.getElementById('fontSize');
    function resetFsBoxVal () {
      fsBox.value = monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOptions.fontSize.id);
    }
    resetFsBoxVal();

    function fsBoxChange (e) {
      const val = Number.parseInt(e.target.value);
      if (Number.isNaN(val)) {
        resetFsBoxVal();
        return;
      }
      monaco.editor.getEditors()[0].updateOptions({ fontSize: val });
      resetFsBoxVal();
    }

    function fsBoxIncrByOne (adder) {
      fsBox.value = Math.max(monaco.editor.getEditors()[0].getOption(monaco.editor.EditorOptions.fontSize.id) + adder, 1);
      fsBoxChange({ target: fsBox });
    }

    fsBox.addEventListener('change', fsBoxChange);
    document.getElementById('fontSizeDown').addEventListener('click', fsBoxIncrByOne.bind(null, -1));
    document.getElementById('fontSizeUp').addEventListener('click', fsBoxIncrByOne.bind(null, 1));

    const expCount = document.getElementById('expiryCountdown');
    const expires = new Date(Number.parseInt(expCount.dataset.expiry) * 1000);
    let updateExpiryHandle;
    function updateExpiry () {
      const remainSeconds = Math.floor((expires - new Date()) / 1000);
      let updateText = `${remainSeconds} seconds`;
      let fontColorNew = 'red';

      if (remainSeconds > 120) {
        const remainMinutes = Math.floor(remainSeconds / 60);
        if (remainMinutes < 120) {
          updateText = `${remainMinutes} minute${remainMinutes > 1 ? 's' : ''}`;
        } else {
          updateText = `about ${Math.floor(remainMinutes / 60)} hours`;
        }
        fontColorNew = null;
      }

      expCount.innerText = updateText;

      if (fontColorNew) {
        expCount.style.color = fontColorNew;
      }

      if (remainSeconds < 0) {
        clearInterval(updateStateHandle);
        updateStateHandle = null;
        if (!readOnly) {
          saveButton.disabled = true;
          saveButton.innerText = 'Expired!';
          saveButton.style.color = 'red';
          saveButton.removeEventListener('click', clickListener);
          document.getElementById('sidebar_state').style.color = '#997777';
          document.getElementById('show_state').style.display =
              document.getElementById('expiryCountdownCont').style.display = 'none';
        }
        document.getElementById('expOuter').style.color = 'red';
        monaco.editor.getEditors()[0].updateOptions({ readOnly: true });
        // eslint-disable-next-line no-unused-expressions, no-sequences
        clearInterval(updateExpiryHandle), updateExpiryHandle = null;
      }
    }

    updateExpiry();
    updateExpiryHandle = setInterval(updateExpiry, 1000);

    if (!readOnly) {
      document.getElementById('show_state').addEventListener('click', toggleStateSidebar);
    }
  });
}
