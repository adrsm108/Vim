import * as vscode from 'vscode';
import { Globals } from '../globals';
import { Notation } from './notation';
import { ValidatorResults } from './iconfigurationValidator';
import { VSCodeContext } from '../util/vscodeContext';
import { configurationValidator } from './configurationValidator';
import { decoration } from './decoration';
import * as process from 'process';

import {
  IConfiguration,
  IKeyRemapping,
  IModeSpecificStrings,
  IAutoSwitchInputMethod,
  IDebugConfiguration,
  IHighlightedYankConfiguration,
  ICamelCaseMotionConfiguration,
} from './iconfiguration';

import * as packagejson from '../../package.json';
import { SUPPORT_VIMRC } from 'platform/constants';

// https://stackovrflow.com/questions/51465182/how-to-remove-index-signature-using-mapped-types/51956054#51956054
type RemoveIndex<T> = {
  [P in keyof T as string extends P ? never : number extends P ? never : P]: T[P];
};

export const extensionVersion = packagejson.version;

/**
 * Most options supported by Vim have a short alias. They are provided here.
 * Please keep this list up to date and sorted alphabetically.
 */
export const optionAliases: ReadonlyMap<string, string> = new Map<string, string>([
  ['ai', 'autoindent'],
  ['et', 'expandtab'],
  ['gd', 'gdefault'],
  ['hi', 'history'],
  ['hls', 'hlsearch'],
  ['ic', 'ignorecase'],
  ['icm', 'inccommand'],
  ['is', 'incsearch'],
  ['isk', 'iskeyword'],
  ['js', 'joinspaces'],
  ['mmd', 'maxmapdepth'],
  ['mps', 'matchpairs'],
  ['nu', 'number'],
  ['rnu', 'relativenumber'],
  ['sc', 'showcmd'],
  ['scr', 'scroll'],
  ['scs', 'smartcase'],
  ['smd', 'showmode'],
  ['sol', 'startofline'],
  ['to', 'timeout'],
  ['ts', 'tabstop'],
  ['tw', 'textwidth'],
  ['ws', 'wrapscan'],
  ['ww', 'whichwrap'],
]);

type OptionValue = number | string | boolean;

interface VSCodeKeybinding {
  key: string;
  mac?: string;
  linux?: string;
  command: string;
  when: string;
}

interface IHandleKeys {
  [key: string]: boolean;
}

interface IKeyBinding {
  key: string;
  command: string;
}

/**
 * Every Vim option we support should
 * 1. Be added to contribution section of `package.json`.
 * 2. Named as `vim.{optionName}`, `optionName` is the name we use in Vim.
 * 3. Define a public property in `Configuration` with the same name and a default value.
 *    Or define a private property and define customized Getter/Setter accessors for it.
 *    Always remember to decorate Getter accessor as @enumerable()
 * 4. If user doesn't set the option explicitly
 *    a. we don't have a similar setting in Code, initialize the option as default value.
 *    b. we have a similar setting in Code, use Code's setting.
 *
 * Vim option override sequence.
 * 1. `:set {option}` on the fly
 * 2. `vim.{option}`
 * 3. VS Code configuration
 * 4. VSCodeVim configuration default values
 *
 */
class Configuration implements IConfiguration {
  private readonly leaderDefault = '\\';
  private readonly cursorTypeMap = {
    line: vscode.TextEditorCursorStyle.Line,
    block: vscode.TextEditorCursorStyle.Block,
    underline: vscode.TextEditorCursorStyle.Underline,
    'line-thin': vscode.TextEditorCursorStyle.LineThin,
    'block-outline': vscode.TextEditorCursorStyle.BlockOutline,
    'underline-thin': vscode.TextEditorCursorStyle.UnderlineThin,
  };

  public async load(): Promise<ValidatorResults> {
    const vimConfigs: { [key: string]: any } = Globals.isTesting
      ? Globals.mockConfiguration
      : this.getConfiguration('vim');

    // tslint:disable-next-line: forin
    for (const option in this) {
      let val = vimConfigs[option];
      if (val !== null && val !== undefined) {
        if (val.constructor.name === Object.name) {
          val = Configuration.unproxify(val);
        }
        this[option] = val;
      }
    }

    if (SUPPORT_VIMRC && this.vimrc.enable) {
      await import('./vimrc').then((vimrcModel) => {
        return vimrcModel.vimrc.load(this);
      });
    }

    this.leader = Notation.NormalizeKey(this.leader, this.leaderDefault);

    this.clearKeyBindingsMaps();

    const validatorResults = await configurationValidator.validate(configuration);

    // read package.json for bound keys
    // enable/disable certain key combinations
    this.boundKeyCombinations = [];
    for (const keybinding of packagejson.contributes.keybindings) {
      if (keybinding.when.includes('listFocus')) {
        continue;
      }

      if (keybinding.command.startsWith('notebook')) {
        continue;
      }

      let key = keybinding.key;
      if (process.platform === 'darwin') {
        key = keybinding.mac || key;
      } else if (process.platform === 'linux') {
        key = keybinding.linux || key;
      }

      this.boundKeyCombinations.push({
        key: Notation.NormalizeKey(key, this.leader),
        command: keybinding.command,
      });
    }

    // decorations
    decoration.load(this);

    for (const boundKey of this.boundKeyCombinations) {
      // By default, all key combinations are used
      let useKey = true;

      const handleKey = this.handleKeys[boundKey.key];
      if (handleKey !== undefined) {
        // enabled/disabled through `vim.handleKeys`
        useKey = handleKey;
      } else if (!this.useCtrlKeys && boundKey.key.slice(1, 3) === 'C-') {
        // user has disabled CtrlKeys and the current key is a CtrlKey
        // <C-c>, still needs to be captured to overrideCopy
        if (boundKey.key === '<C-c>' && this.overrideCopy) {
          useKey = true;
        } else {
          useKey = false;
        }
      }

      VSCodeContext.set(`vim.use${boundKey.key}`, useKey);
    }

    VSCodeContext.set('vim.overrideCopy', this.overrideCopy);
    VSCodeContext.set('vim.overrideCtrlC', this.overrideCopy || this.useCtrlKeys);

    return validatorResults;
  }

  getConfiguration(section: string = ''): RemoveIndex<vscode.WorkspaceConfiguration> {
    const document = vscode.window.activeTextEditor?.document;
    const resource = document ? { uri: document.uri, languageId: document.languageId } : undefined;
    return vscode.workspace.getConfiguration(section, resource);
  }

  cursorStyleFromString(cursorStyle: string): vscode.TextEditorCursorStyle | undefined {
    return this.cursorTypeMap[cursorStyle];
  }

  clearKeyBindingsMaps() {
    // Clear the KeyBindingsMaps so that the previous configuration maps don't leak to this one
    this.normalModeKeyBindingsMap = new Map<string, IKeyRemapping>();
    this.insertModeKeyBindingsMap = new Map<string, IKeyRemapping>();
    this.visualModeKeyBindingsMap = new Map<string, IKeyRemapping>();
    this.commandLineModeKeyBindingsMap = new Map<string, IKeyRemapping>();
    this.operatorPendingModeKeyBindingsMap = new Map<string, IKeyRemapping>();
  }

  handleKeys: IHandleKeys[] = [];

  useSystemClipboard = false;

  shell = '';

  useCtrlKeys = false;

  overrideCopy = true;

  textwidth = 80;

  hlsearch = false;

  ignorecase = true;

  smartcase = true;

  autoindent = true;

  matchpairs = '(:),{:},[:]';

  joinspaces = true;

  camelCaseMotion: ICamelCaseMotionConfiguration = {
    enable: true,
  };

  replaceWithRegister = false;

  smartRelativeLine = false;

  sneak = false;
  sneakUseIgnorecaseAndSmartcase = false;
  sneakReplacesF = false;

  surround = true;

  argumentObjectSeparators = [','];
  argumentObjectOpeningDelimiters = ['(', '['];
  argumentObjectClosingDelimiters = [')', ']'];

  easymotion = false;
  easymotionMarkerBackgroundColor = '#0000';
  easymotionMarkerForegroundColorOneChar = '#ff0000';
  easymotionMarkerForegroundColorTwoChar = '#ffa500'; // Deprecated! Use the ones bellow
  easymotionMarkerForegroundColorTwoCharFirst = '#ffb400';
  easymotionMarkerForegroundColorTwoCharSecond = '#b98300';
  easymotionIncSearchForegroundColor = '#7fbf00';
  easymotionDimColor = '#777777';
  easymotionMarkerWidthPerChar = 8; // Deprecated! No longer needed!
  easymotionDimBackground = true;
  easymotionMarkerFontFamily = 'Consolas'; // Deprecated! No longer needed!
  easymotionMarkerFontSize = '14'; // Deprecated! No longer needed!
  easymotionMarkerFontWeight = 'bold';
  easymotionMarkerMargin = 0; // Deprecated! No longer needed!
  easymotionKeys = 'hklyuiopnm,qwertzxcvbasdgjf;';
  easymotionJumpToAnywhereRegex = '\\b[A-Za-z0-9]|[A-Za-z0-9]\\b|_.|#.|[a-z][A-Z]';

  autoSwitchInputMethod: IAutoSwitchInputMethod = {
    enable: false,
    defaultIM: '',
    obtainIMCmd: '',
    switchIMCmd: '',
  };

  timeout = 1000;

  maxmapdepth = 1000;

  showcmd = true;

  showmodename = true;

  leader = this.leaderDefault;

  history = 50;

  inccommand: '' | 'append' | 'replace' = '';

  incsearch = true;

  startInInsertMode = false;

  statusBarColorControl = false;

  statusBarColors: IModeSpecificStrings<string | string[]> = {
    normal: '#005f5f',
    insert: '#5f0000',
    visual: '#5f00af',
    visualline: '#005f87',
    visualblock: '#86592d',
    replace: '#000000',
  };

  debug: IDebugConfiguration = {
    silent: false,
    loggingLevelForAlert: 'error',
    loggingLevelForConsole: 'error',
  };

  searchHighlightColor = '';
  searchHighlightTextColor = '';

  searchMatchColor = '';
  searchMatchTextColor = '';

  substitutionColor = '#50f01080';
  substitutionTextColor = '';

  highlightedyank: IHighlightedYankConfiguration = {
    enable: false,
    color: 'rgba(250, 240, 170, 0.5)',
    textColor: '',
    duration: 200,
  };

  @overlapSetting({ settingName: 'tabSize', defaultValue: 8 })
  tabstop!: number;

  @overlapSetting({ settingName: 'cursorStyle', defaultValue: 'line' })
  private editorCursorStyleRaw!: string;

  get editorCursorStyle(): vscode.TextEditorCursorStyle | undefined {
    return this.cursorStyleFromString(this.editorCursorStyleRaw);
  }
  set editorCursorStyle(val: vscode.TextEditorCursorStyle | undefined) {
    // nop
  }

  @overlapSetting({ settingName: 'insertSpaces', defaultValue: false })
  expandtab!: boolean;

  @overlapSetting({
    settingName: 'lineNumbers',
    defaultValue: true,
    map: new Map([
      ['on', true],
      ['off', false],
      ['relative', false],
      ['interval', false],
    ]),
  })
  number!: boolean;

  @overlapSetting({
    settingName: 'lineNumbers',
    defaultValue: false,
    map: new Map([
      ['on', false],
      ['off', false],
      ['relative', true],
      ['interval', false],
    ]),
  })
  relativenumber!: boolean;

  @overlapSetting({
    settingName: 'wordSeparators',
    defaultValue: '/\\()"\':,.;<>~!@#$%^&*|+=[]{}`?-',
  })
  iskeyword!: string;

  @overlapSetting({
    settingName: 'wordWrap',
    defaultValue: false,
    map: new Map([
      ['on', true],
      ['off', false],
      ['wordWrapColumn', true],
      ['bounded', true],
    ]),
  })
  wrap!: boolean;

  boundKeyCombinations: IKeyBinding[] = [];

  visualstar = false;

  mouseSelectionGoesIntoVisualMode = true;

  changeWordIncludesWhitespace = false;

  foldfix = false;

  disableExtension: boolean = false;

  enableNeovim = false;
  neovimPath = '';
  neovimUseConfigFile = false;
  neovimConfigPath = '';

  vimrc = {
    enable: false,
    path: '',
  };

  digraphs = {};

  gdefault = false;
  substituteGlobalFlag = false; // Deprecated in favor of gdefault

  whichwrap = 'b,s';

  startofline = true;

  showMarksInGutter = false;

  report = 2;
  wrapscan = true;

  scroll = 0;
  getScrollLines(visibleRanges: vscode.Range[]): number {
    return this.scroll === 0
      ? Math.ceil((visibleRanges[0].end.line - visibleRanges[0].start.line) / 2)
      : this.scroll;
  }

  cursorStylePerMode: IModeSpecificStrings<string> = {
    normal: undefined,
    insert: undefined,
    visual: undefined,
    visualline: undefined,
    visualblock: undefined,
    replace: undefined,
  };

  getCursorStyleForMode(modeName: string): vscode.TextEditorCursorStyle | undefined {
    const cursorStyle = this.cursorStylePerMode[modeName.toLowerCase()];
    if (cursorStyle) {
      return this.cursorStyleFromString(cursorStyle);
    }

    return;
  }

  // remappings
  insertModeKeyBindings: IKeyRemapping[] = [];
  insertModeKeyBindingsNonRecursive: IKeyRemapping[] = [];
  normalModeKeyBindings: IKeyRemapping[] = [];
  normalModeKeyBindingsNonRecursive: IKeyRemapping[] = [];
  operatorPendingModeKeyBindings: IKeyRemapping[] = [];
  operatorPendingModeKeyBindingsNonRecursive: IKeyRemapping[] = [];
  visualModeKeyBindings: IKeyRemapping[] = [];
  visualModeKeyBindingsNonRecursive: IKeyRemapping[] = [];
  commandLineModeKeyBindings: IKeyRemapping[] = [];
  commandLineModeKeyBindingsNonRecursive: IKeyRemapping[] = [];

  insertModeKeyBindingsMap: Map<string, IKeyRemapping> = new Map();
  normalModeKeyBindingsMap: Map<string, IKeyRemapping> = new Map();
  operatorPendingModeKeyBindingsMap: Map<string, IKeyRemapping> = new Map();
  visualModeKeyBindingsMap: Map<string, IKeyRemapping> = new Map();
  commandLineModeKeyBindingsMap: Map<string, IKeyRemapping> = new Map();

  private static unproxify(obj: object): object {
    const result = {};
    // tslint:disable-next-line: forin
    for (const key in obj) {
      const val = obj[key] as any;
      if (val !== null && val !== undefined) {
        result[key] = val;
      }
    }
    return result;
  }
}

// handle mapped settings between vscode to vim
function overlapSetting(args: {
  settingName: string;
  defaultValue: OptionValue;
  map?: Map<string | number | boolean, string | number | boolean>;
}) {
  return (target: any, propertyKey: string) => {
    Object.defineProperty(target, propertyKey, {
      get() {
        // retrieve value from vim configuration
        // if the value is not defined or empty
        // look at the equivalent `editor` setting
        // if that is not defined then defer to the default value
        let val = this['_' + propertyKey];
        if (val !== undefined && val !== '') {
          return val;
        }

        val = this.getConfiguration('editor').get(args.settingName, args.defaultValue);
        if (args.map && val !== undefined) {
          val = args.map.get(val);
        }

        return val;
      },
      set(value) {
        // synchronize the vim setting with the `editor` equivalent
        this['_' + propertyKey] = value;

        if (value === undefined || value === '' || Globals.isTesting) {
          return;
        }

        if (args.map) {
          for (const [vscodeSetting, vimSetting] of args.map.entries()) {
            if (value === vimSetting) {
              value = vscodeSetting;
              break;
            }
          }
        }

        // update configuration asynchronously
        this.getConfiguration('editor').update(
          args.settingName,
          value,
          vscode.ConfigurationTarget.Global
        );
      },
      enumerable: true,
      configurable: true,
    });
  };
}

export const configuration = new Configuration();
