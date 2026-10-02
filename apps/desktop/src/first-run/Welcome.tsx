import { ChevronRight, FolderInput, FolderPlus, type LucideIcon } from 'lucide-react';
import { type Ref, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'react-aria-components';

import { DeskIllustration } from '../components/DeskIllustration/DeskIllustration';
import appMark from '../titlebar/app-mark.svg';
import { SIZE } from '../tokens/tokens';
import { useChooseFolder } from './choose';
import { Frame } from './Frame';
import type { Intent } from '../app/startFlow';

interface ChoiceCardProps {
  icon: LucideIcon;
  title: string;
  text: string;
  onPress: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/** One way to start (§3): a button named by its title, described by its text. */
function ChoiceCard({ icon: Icon, title, text, onPress, ref }: ChoiceCardProps) {
  const titleId = useId();
  const textId = useId();
  return (
    <Button ref={ref} className="choice-card" aria-labelledby={titleId} aria-describedby={textId} onPress={onPress}>
      <span className="choice-card__tile" aria-hidden>
        <Icon size={SIZE.iconLarge} />
      </span>
      <span className="choice-card__words">
        <span id={titleId} className="choice-card__title">
          {title}
        </span>
        <span id={textId} className="choice-card__text">
          {text}
        </span>
      </span>
      <ChevronRight aria-hidden size={SIZE.icon} className="choice-card__chevron" />
    </Button>
  );
}

/**
 * The welcome screen (first-run handoff §3, decision 28B): the title and the two ways to start on
 * the left, the desk illustration on a dot grid on the right. All three choices open the same
 * folder dialog; what follows depends on the folder.
 */
export function Welcome() {
  const { t } = useTranslation('first-run');
  const first = useRef<HTMLButtonElement>(null);
  const { choose, busy } = useChooseFolder();
  const onPress = (intent: Intent) => () => {
    void choose(intent);
  };

  return (
    <Frame windowTitle={t('documentTitle.welcome')} focus={first} layout="welcome" busy={busy}>
      <div className="welcome">
        <div className="welcome__column">
          <div className="welcome__head">
            <img
              src={appMark}
              alt=""
              className="welcome__icon"
              width={SIZE.appIconLarge}
              height={SIZE.appIconLarge}
              draggable={false}
            />
            <h1 className="welcome__title">{t('welcome.title')}</h1>
            <p className="welcome__intro">{t('welcome.intro')}</p>
          </div>
          <div className="welcome__choices">
            <ChoiceCard
              ref={first}
              icon={FolderPlus}
              title={t('welcome.newLibrary.title')}
              text={t('welcome.newLibrary.text')}
              onPress={onPress('new')}
            />
            <ChoiceCard
              icon={FolderInput}
              title={t('welcome.existing.title')}
              text={t('welcome.existing.text')}
              onPress={onPress('existing')}
            />
          </div>
          <p className="welcome__open">
            {t('welcome.openLead')}{' '}
            <Button className="link-button" onPress={onPress('open')}>
              {t('welcome.open')}
            </Button>
          </p>
          <p className="welcome__footer">{t('welcome.footer')}</p>
        </div>
        <div className="welcome__art" aria-hidden>
          <DeskIllustration />
        </div>
      </div>
    </Frame>
  );
}
