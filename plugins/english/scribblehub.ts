import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';
import { Plugin } from '@/types/plugin';
import dayjs from 'dayjs';

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

class ScribbleHubPlugin implements Plugin.PluginBase {
  id = 'scribblehub';
  name = 'Scribble Hub';
  icon = 'src/en/scribblehub/icon.png';
  site = 'https://www.scribblehub.com/';
  version = '1.1.0';

  parseReleaseTime(dateText: string): string | null {
    const relative = dateText.match(
      /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i,
    );
    if (relative) {
      const unit = relative[2].toLowerCase() as dayjs.ManipulateType;
      return dayjs().subtract(parseInt(relative[1], 10), unit).toISOString();
    }

    // Absolute dates look like "Nov 1, 2026 06:07 PM" or "Nov 1, 2026".
    const absolute = dateText.match(
      /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i,
    );
    if (!absolute) return null;

    const month = MONTHS.indexOf(absolute[1].toLowerCase());
    if (month === -1) return null;

    let hour = absolute[4] ? parseInt(absolute[4], 10) % 12 : 0;
    if (absolute[6]?.toUpperCase() === 'PM') hour += 12;
    const minute = absolute[5] ? parseInt(absolute[5], 10) : 0;

    return new Date(
      parseInt(absolute[3], 10),
      month,
      parseInt(absolute[2], 10),
      hour,
      minute,
    ).toISOString();
  }

  parseNovels(loadedCheerio: CheerioAPI) {
    const novels: Plugin.NovelItem[] = [];

    loadedCheerio('.search_main_box').each((i, el) => {
      const novelName = loadedCheerio(el).find('.search_title > a').text();
      const novelCover = loadedCheerio(el)
        .find('.search_img > img')
        .attr('src');
      const novelUrl = loadedCheerio(el).find('.search_title > a').attr('href');

      if (!novelUrl) return;

      const novel = {
        name: novelName,
        cover: novelCover,
        path: novelUrl.replace(this.site, ''),
      };
      novels.push(novel);
    });
    return novels;
  }

  async popularNovels(
    page: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let url = `${this.site}`;

    const date = new Date();
    date.setDate(date.getDate() - 1); // change to yesterday
    const lastUpdateMinDate = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

    if (showLatestNovels) {
      url += `latest-series/?pg=${page}`;
    } else if (filters) {
      const params = new URLSearchParams();
      if (filters.genres.value.include?.length) {
        params.append('gi', filters.genres.value.include.join(','));
      }
      if (
        filters.genres.value.include?.length ||
        filters.genres.value.exclude?.length
      ) {
        params.append('mgi', filters.genre_operator.value);
      }
      if (filters.genres.value.exclude?.length) {
        params.append('ge', filters.genres.value.exclude.join(','));
      }
      if (filters.tags.value.include?.length) {
        params.append('tgi', filters.tags.value.include.join(','));
      }
      if (
        filters.tags.value.include?.length ||
        filters.tags.value.exclude?.length
      ) {
        params.append('mtgi', filters.tag_operator.value);
      }
      if (filters.tags.value.exclude?.length) {
        params.append('tge', filters.tags.value.exclude.join(','));
      }
      if (filters.content_warning.value.include?.length) {
        params.append('cti', filters.content_warning.value.include.join(','));
      }
      if (
        filters.content_warning.value.include?.length ||
        filters.content_warning.value.exclude?.length
      ) {
        params.append('mct', filters.content_warning_operator.value);
      }
      if (filters.content_warning.value.exclude?.length) {
        params.append('cte', filters.content_warning.value.exclude.join(','));
      }
      params.append('cp', filters.storyStatus.value);
      params.append('sort', filters.sort.value);
      params.append('order', filters.order.value);
      params.append('pg', page.toString());
      url += `series-finder/?sf=1&${params.toString()}`;
    } else {
      url += `series-finder/?sf=1&sort=pageviews&order=desc&pg=${page}&mnlcd=${lastUpdateMinDate}`;
    }

    // if default url, only show last 2 days novels
    if (
      url ==
      `${this.site}series-finder/?sf=1&cp=all&sort=pageviews&order=desc&pg=${page}`
    ) {
      url += `&mnlcd=${lastUpdateMinDate}`;
    }

    const body = await fetchApi(url).then(result => result.text());

    const loadedCheerio = parseHTML(body);
    return this.parseNovels(loadedCheerio);
  }

  parseTocChapters(loadedCheerio: CheerioAPI): Plugin.ChapterItem[] {
    const chapters: Plugin.ChapterItem[] = [];
    loadedCheerio('.toc_w').each((i, el) => {
      const chapterLink = loadedCheerio(el).find('a.toc_a');
      const chapterUrl = chapterLink.attr('href');
      if (!chapterUrl) return;

      const releaseDate = loadedCheerio(el).find('.fic_date_pub');
      const chapterNumber = parseInt(loadedCheerio(el).attr('order') || '', 10);

      chapters.push({
        name: chapterLink.text().trim(),
        path: chapterUrl.replace(this.site, ''),
        releaseTime: this.parseReleaseTime(
          releaseDate.attr('title') || releaseDate.text(),
        ),
        chapterNumber: isNaN(chapterNumber) ? undefined : chapterNumber,
      });
    });
    return chapters;
  }

  async fetchAllChapters(
    novelPath: string,
    loadedCheerio: CheerioAPI,
  ): Promise<Plugin.ChapterItem[]> {
    const novelId = loadedCheerio('input#mypostid').attr('value');
    if (!novelId) return [];

    const result = await fetchApi(`${this.site}wp-admin/admin-ajax.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: this.site + novelPath,
        Origin: this.site.slice(0, -1),
      },
      body: new URLSearchParams({
        action: 'wi_getreleases_pagination',
        pagenum: '-1',
        mypostid: novelId,
      }).toString(),
    });

    if (!result.ok) return [];

    return this.parseTocChapters(parseHTML(await result.text()));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const result = await fetchApi(this.site + novelPath);
    // const result = await fetchApi(this.site + novelPath + '?toc=-1');
    const body = await result.text();

    const loadedCheerio = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('.fic_title').text() || 'Untitled',
      cover: loadedCheerio('.fic_image > img').attr('src'),
      summary: loadedCheerio('.wi_fic_desc').text(),
      author: loadedCheerio('.auth_name_fic').text(),
    };

    novel.genres = loadedCheerio('.fic_genre')
      .map((i, el) => loadedCheerio(el).text())
      .toArray()
      .join(',');

    const statusText = loadedCheerio('i.status').closest('li').text();
    if (statusText.includes('Ongoing')) {
      novel.status = NovelStatus.Ongoing;
    } else if (statusText.includes('Hiatus')) {
      novel.status = NovelStatus.OnHiatus;
    } else if (statusText.includes('Completed')) {
      novel.status = NovelStatus.Completed;
    } else {
      novel.status = NovelStatus.Unknown;
    }

    // The novel page only lists the latest chapters; fall back to them if the
    // full table of contents request fails.
    const pageChapters = this.parseTocChapters(loadedCheerio);
    const allChapters = await this.fetchAllChapters(
      novelPath,
      loadedCheerio,
    ).catch((): Plugin.ChapterItem[] => []);
    const chapters =
      allChapters.length > pageChapters.length ? allChapters : pageChapters;

    novel.chapters = chapters.sort(
      (a, b) => (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0),
    );

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const result = await fetchApi(this.site + chapterPath);
    const body = await result.text();

    const loadedCheerio = parseHTML(body);

    const chapterText = loadedCheerio('div.chp_raw').html() || '';
    return chapterText;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url = `${this.site}series-finder/?sf=1&sh=${encodeURIComponent(searchTerm)}&pg=${pageNo}`;
    const result = await fetchApi(url);
    const body = await result.text();

    const loadedCheerio = parseHTML(body);
    return this.parseNovels(loadedCheerio);
  }

  filters = {
    sort: {
      label: 'Sort Results By',
      value: 'pageviews',
      options: [
        { label: 'Chapters', value: 'chapters' },
        { label: 'Chapters per Week', value: 'frequency' },
        { label: 'Date Added', value: 'dateadded' },
        { label: 'Favorites', value: 'favorites' },
        { label: 'Last Updated', value: 'lastchpdate' },
        { label: 'Number of Ratings', value: 'numofrate' },
        { label: 'Pages', value: 'pages' },
        { label: 'Pageviews', value: 'pageviews' },
        { label: 'Ratings', value: 'ratings' },
        { label: 'Readers', value: 'readers' },
        { label: 'Reviews', value: 'reviews' },
        { label: 'Total Words', value: 'totalwords' },
      ],
      type: FilterTypes.Picker,
    },
    order: {
      label: 'Order By',
      value: 'desc',
      options: [
        { label: 'Descending', value: 'desc' },
        { label: 'Ascending', value: 'asc' },
      ],
      type: FilterTypes.Picker,
    },
    storyStatus: {
      label: 'Story Status',
      value: 'all',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Completed', value: 'completed' },
        { label: 'Ongoing', value: 'ongoing' },
        { label: 'Hiatus', value: 'hiatus' },
      ],
      type: FilterTypes.Picker,
    },
    genre_operator: {
      value: 'and',
      label: 'Genres (And/Or)',
      options: [
        { label: 'And', value: 'and' },
        { label: 'Or', value: 'or' },
      ],
      type: FilterTypes.Picker,
    },
    genres: {
      label: 'Genres',
      value: {
        include: [],
        exclude: [],
      },
      options: [
        { label: 'Action', value: '9' },
        { label: 'Adult', value: '902' },
        { label: 'Adventure', value: '8' },
        { label: 'Boys Love', value: '891' },
        { label: 'Comedy', value: '7' },
        { label: 'Drama', value: '903' },
        { label: 'Ecchi', value: '904' },
        { label: 'Fanfiction', value: '38' },
        { label: 'Fantasy', value: '19' },
        { label: 'Gender Bender', value: '905' },
        { label: 'Girls Love', value: '892' },
        { label: 'Harem', value: '1015' },
        { label: 'Historical', value: '21' },
        { label: 'Horror', value: '22' },
        { label: 'Isekai', value: '37' },
        { label: 'Josei', value: '906' },
        { label: 'LitRPG', value: '1180' },
        { label: 'Martial Arts', value: '907' },
        { label: 'Mature', value: '20' },
        { label: 'Mecha', value: '908' },
        { label: 'Mystery', value: '909' },
        { label: 'Psychological', value: '910' },
        { label: 'Romance', value: '6' },
        { label: 'School Life', value: '911' },
        { label: 'Sci-fi', value: '912' },
        { label: 'Seinen', value: '913' },
        { label: 'Slice of Life', value: '914' },
        { label: 'Smut', value: '915' },
        { label: 'Sports', value: '916' },
        { label: 'Supernatural', value: '5' },
        { label: 'Tragedy', value: '901' },
      ],
      type: FilterTypes.ExcludableCheckboxGroup,
    },
    tag_operator: {
      value: 'and',
      label: 'Tags (And/Or)',
      options: [
        { label: 'And', value: 'and' },
        { label: 'Or', value: 'or' },
      ],
      type: FilterTypes.Picker,
    },
    tags: {
      label: 'Tags',
      value: {
        include: [],
        exclude: [],
      },
      options: [
        { label: 'Abandoned Children', value: '119' },
        { label: 'Ability Steal', value: '120' },
        { label: 'Absent Parents', value: '121' },
        { label: 'Abusive Characters', value: '122' },
        { label: 'Academy', value: '123' },
        { label: 'Accelerated Growth', value: '124' },
        { label: 'Acting', value: '125' },
        { label: 'Adopted Children', value: '137' },
        { label: 'Adopted Protagonist', value: '138' },
        { label: 'Adultery', value: '139' },
        { label: 'Adventurers', value: '140' },
        { label: 'Affair', value: '141' },
        { label: 'Age Progression', value: '142' },
        { label: 'Age Regression', value: '143' },
        { label: 'Aggressive Characters', value: '144' },
        { label: 'Alchemy', value: '145' },
        { label: 'Aliens', value: '146' },
        { label: 'All-Girls School', value: '147' },
        { label: 'Alternate World', value: '148' },
        { label: 'Amnesia', value: '149' },
        { label: 'Amusement Park', value: '150' },
        { label: 'Ancient China', value: '152' },
        { label: 'Ancient Times', value: '153' },
        { label: 'Androgynous Characters', value: '154' },
        { label: 'Androids', value: '155' },
        { label: 'Angels', value: '156' },
        { label: 'Animal Characteristics', value: '157' },
        { label: 'Animal Rearing', value: '158' },
        { label: 'Anti-Magic', value: '159' },
        { label: 'Anti-social Protagonist', value: '160' },
        { label: 'Antihero Protagonist', value: '161' },
        { label: 'Antique Shop', value: '162' },
        { label: 'Apartment Life', value: '163' },
        { label: 'Apathetic Protagonist', value: '164' },
        { label: 'Apocalypse', value: '165' },
        { label: 'Appearance Changes', value: '166' },
        { label: 'Appearance Different from Actual Age', value: '167' },
        { label: 'Archery', value: '168' },
        { label: 'Aristocracy', value: '169' },
        { label: 'Arms Dealers', value: '170' },
        { label: 'Army', value: '171' },
        { label: 'Army Building', value: '172' },
        { label: 'Arranged Marriage', value: '173' },
        { label: 'Arrogant Characters', value: '174' },
        { label: 'Artifact Crafting', value: '175' },
        { label: 'Artifacts', value: '176' },
        { label: 'Artificial Intelligence', value: '177' },
        { label: 'Artists', value: '178' },
        { label: 'Assassins', value: '179' },
        { label: 'Astrologers', value: '180' },
        { label: 'Autism', value: '181' },
        { label: 'Automatons', value: '182' },
        { label: 'Average-looking Protagonist', value: '183' },
        { label: 'Awkward Protagonist', value: '185' },
        { label: 'Bands', value: '186' },
        { label: 'Based on a Movie', value: '187' },
        { label: 'Based on a Song', value: '188' },
        { label: 'Based on a Video Game', value: '190' },
        { label: 'Based on a Visual Novel', value: '191' },
        { label: 'Based on an Anime', value: '192' },
        { label: 'Battle Academy', value: '193' },
        { label: 'Battle Competition', value: '194' },
        { label: 'BDSM', value: '195' },
        { label: 'Beast Companions', value: '196' },
        { label: 'Beastkin', value: '197' },
        { label: 'Beasts', value: '198' },
        { label: 'Beautiful Couple', value: '199' },
        { label: 'Beautiful Female Lead', value: '200' },
        { label: 'Betrayal', value: '202' },
        { label: 'Bickering Couple', value: '203' },
        { label: 'Biochip', value: '204' },
        { label: 'Biography', value: '205' },
        { label: 'Bisexual Protagonist', value: '206' },
        { label: 'Black Belly', value: '207' },
        { label: 'Blackmail', value: '208' },
        { label: 'Blacksmith', value: '209' },
        { label: 'Blind Dates', value: '210' },
        { label: 'Blind Protagonist', value: '211' },
        { label: 'Blood Manipulation', value: '212' },
        { label: 'Bloodlines', value: '213' },
        { label: 'Body Swap', value: '214' },
        { label: 'Body Tempering', value: '215' },
        { label: 'Body-double', value: '216' },
        { label: 'Bodyguards', value: '217' },
        { label: 'Books', value: '218' },
        { label: 'Bookworm', value: '219' },
        { label: 'Boss-Subordinate Relationship', value: '220' },
        { label: 'Boy_s Love Subplot', value: '760' },
        { label: 'Brainwashing', value: '221' },
        { label: 'Broken Engagement', value: '223' },
        { label: 'Brother Complex', value: '224' },
        { label: 'Brotherhood', value: '225' },
        { label: 'Buddhism', value: '226' },
        { label: 'Bullying', value: '227' },
        { label: 'Business Management', value: '228' },
        { label: 'Businessmen', value: '229' },
        { label: 'Butlers', value: '230' },
        { label: 'Calm Protagonist', value: '231' },
        { label: 'Cannibalism', value: '232' },
        { label: 'Card Games', value: '233' },
        { label: 'Carefree Protagonist', value: '234' },
        { label: 'Caring Protagonist', value: '235' },
        { label: 'Cautious Protagonist', value: '236' },
        { label: 'Celebrities', value: '237' },
        { label: 'Character Growth', value: '238' },
        { label: 'Charismatic Protagonist', value: '239' },
        { label: 'Charming Protagonist', value: '240' },
        { label: 'Chat Rooms', value: '241' },
        { label: 'Cheating', value: '20892' },
        { label: 'Cheats', value: '242' },
        { label: 'Chefs', value: '243' },
        { label: 'Child Abuse', value: '244' },
        { label: 'Child Protagonist', value: '245' },
        { label: 'Childcare', value: '246' },
        { label: 'Childhood Friends', value: '247' },
        { label: 'Childhood Love', value: '248' },
        { label: 'Childhood Promise', value: '249' },
        { label: 'Childish Protagonist', value: '250' },
        { label: 'Chuunibyou', value: '251' },
        { label: 'Clan Building', value: '252' },
        { label: 'Classic', value: '253' },
        { label: 'Clever Protagonist', value: '254' },
        { label: 'Clingy Lover', value: '255' },
        { label: 'Clones', value: '256' },
        { label: 'Clubs', value: '257' },
        { label: 'Clumsy Love Interests', value: '258' },
        { label: 'Co-Workers', value: '259' },
        { label: 'Cohabitation', value: '260' },
        { label: 'Cold Love Interests', value: '261' },
        { label: 'Cold Protagonist', value: '262' },
        { label: 'Collection of Short Stories', value: '263' },
        { label: 'College/University', value: '264' },
        { label: 'Coma', value: '265' },
        { label: 'Comedic Undertone', value: '266' },
        { label: 'Coming of Age', value: '267' },
        { label: 'Complex Family Relationships', value: '268' },
        { label: 'Conditional Power', value: '269' },
        { label: 'Confident Protagonist', value: '270' },
        { label: 'Confinement', value: '271' },
        { label: 'Conflicting Loyalties', value: '272' },
        { label: 'Conspiracies', value: '273' },
        { label: 'Contracts', value: '274' },
        { label: 'Cooking', value: '275' },
        { label: 'Corruption', value: '276' },
        { label: 'Cosmic Wars', value: '277' },
        { label: 'Cosplay', value: '278' },
        { label: 'Couple Growth', value: '279' },
        { label: 'Court Official', value: '280' },
        { label: 'Cousins', value: '281' },
        { label: 'Cowardly Protagonist', value: '282' },
        { label: 'Crafting', value: '283' },
        { label: 'Crazy Protagonist', value: '1534' },
        { label: 'Crime', value: '284' },
        { label: 'Criminals', value: '285' },
        { label: 'Cross-dressing', value: '286' },
        { label: 'Crossover', value: '287' },
        { label: 'Cruel Characters', value: '288' },
        { label: 'Cryostasis', value: '289' },
        { label: 'Cultivation', value: '290' },
        { label: 'Cunning Protagonist', value: '292' },
        { label: 'Curious Protagonist', value: '293' },
        { label: 'Curses', value: '294' },
        { label: 'Cute Children', value: '295' },
        { label: 'Cute Protagonist', value: '296' },
        { label: 'Cute Story', value: '297' },
        { label: 'Cyberpunk', value: '960' },
        { label: 'Dancers', value: '298' },
        { label: 'Dao Companion', value: '299' },
        { label: 'Dao Comprehension', value: '300' },
        { label: 'Daoism', value: '301' },
        { label: 'Dark', value: '302' },
        { label: 'Dead Protagonist', value: '303' },
        { label: 'Death', value: '304' },
        { label: 'Death of Loved Ones', value: '305' },
        { label: 'Debts', value: '306' },
        { label: 'Delinquents', value: '307' },
        { label: 'Delusions', value: '308' },
        { label: 'Demi-Humans', value: '309' },
        { label: 'Demon Lord', value: '310' },
        { label: 'Demonic Cultivation Technique', value: '311' },
        { label: 'Demons', value: '312' },
        { label: 'Dense Protagonist', value: '313' },
        { label: 'Depictions of Cruelty', value: '314' },
        { label: 'Depression', value: '315' },
        { label: 'Destiny', value: '316' },
        { label: 'Detectives', value: '317' },
        { label: 'Determined Protagonist', value: '318' },
        { label: 'Devoted Love Interests', value: '319' },
        { label: 'Different Social Status', value: '320' },
        { label: 'Disabilities', value: '321' },
        { label: 'Discrimination', value: '322' },
        { label: 'Disfigurement', value: '323' },
        { label: 'Dishonest Protagonist', value: '324' },
        { label: 'Distrustful Protagonist', value: '325' },
        { label: 'Divination', value: '326' },
        { label: 'Divine Protection', value: '327' },
        { label: 'Divorce', value: '328' },
        { label: 'Doctors', value: '329' },
        { label: 'Dolls/Puppets', value: '330' },
        { label: 'Domestic Affairs', value: '331' },
        { label: 'Doting Love Interests', value: '332' },
        { label: 'Doting Older Siblings', value: '333' },
        { label: 'Doting Parents', value: '334' },
        { label: 'Dragon Riders', value: '335' },
        { label: 'Dragon Slayers', value: '336' },
        { label: 'Dragons', value: '337' },
        { label: 'Dreams', value: '338' },
        { label: 'Drugs', value: '339' },
        { label: 'Druids', value: '340' },
        { label: 'Dungeon Master', value: '341' },
        { label: 'Dungeons', value: '342' },
        { label: 'Dwarfs', value: '343' },
        { label: 'Dystopia', value: '344' },
        { label: 'e-Sports', value: '345' },
        { label: 'Early Romance', value: '346' },
        { label: 'Earth Invasion', value: '347' },
        { label: 'Easy Going Life', value: '348' },
        { label: 'Economics', value: '349' },
        { label: 'Editors', value: '350' },
        { label: 'Eidetic Memory', value: '351' },
        { label: 'Elderly Protagonist', value: '352' },
        { label: 'Elemental Magic', value: '353' },
        { label: 'Elves', value: '354' },
        { label: 'Emotionally Weak Protagonist', value: '355' },
        { label: 'Empires', value: '356' },
        { label: 'Enemies Become Allies', value: '357' },
        { label: 'Enemies Become Lovers', value: '358' },
        { label: 'Engagement', value: '359' },
        { label: 'Engineer', value: '360' },
        { label: 'Enlightenment', value: '361' },
        { label: 'Episodic', value: '362' },
        { label: 'Eunuch', value: '363' },
        { label: 'European Ambience', value: '364' },
        { label: 'Evil Gods', value: '365' },
        { label: 'Evil Organizations', value: '366' },
        { label: 'Evil Protagonist', value: '367' },
        { label: 'Evil Religions', value: '368' },
        { label: 'Evolution', value: '369' },
        { label: 'Exhibitionism', value: '370' },
        { label: 'Exorcism', value: '371' },
        { label: 'Eye Powers', value: '372' },
        { label: 'Fairies', value: '373' },
        { label: 'Fallen Angels', value: '374' },
        { label: 'Fallen Nobility', value: '375' },
        { label: 'Familial Love', value: '376' },
        { label: 'Familiars', value: '377' },
        { label: 'Family', value: '378' },
        { label: 'Family Business', value: '379' },
        { label: 'Family Conflict', value: '380' },
        { label: 'Famous Parents', value: '381' },
        { label: 'Famous Protagonist', value: '382' },
        { label: 'Fanaticism', value: '383' },
        { label: 'Fantasy Creatures', value: '385' },
        { label: 'Fantasy World', value: '386' },
        { label: 'Farming', value: '387' },
        { label: 'Fast Cultivation', value: '388' },
        { label: 'Fast Learner', value: '389' },
        { label: 'Fat Protagonist', value: '390' },
        { label: 'Fat to Fit', value: '391' },
        { label: 'Fated Lovers', value: '392' },
        { label: 'Fearless Protagonist', value: '393' },
        { label: 'Female Master', value: '395' },
        { label: 'Female Protagonist', value: '892' },
        { label: 'Female to Male', value: '397' },
        { label: 'Feng Shui', value: '398' },
        { label: 'Firearms', value: '399' },
        { label: 'First Love', value: '400' },
        { label: 'First-time Intercourse', value: '401' },
        { label: 'Flashbacks', value: '402' },
        { label: 'Fleet Battles', value: '403' },
        { label: 'Folklore', value: '404' },
        { label: 'Forced into a Relationship', value: '405' },
        { label: 'Forced Living Arrangements', value: '406' },
        { label: 'Forced Marriage', value: '407' },
        { label: 'Forgetful Protagonist', value: '408' },
        { label: 'Former Hero', value: '409' },
        { label: 'Fourth Wall', value: '1150' },
        { label: 'Fox Spirits', value: '410' },
        { label: 'Friends Become Enemies', value: '411' },
        { label: 'Friendship', value: '412' },
        { label: 'Fujoshi', value: '413' },
        { label: 'Futanari', value: '414' },
        { label: 'Futuristic Setting', value: '415' },
        { label: 'Galge', value: '416' },
        { label: 'Gambling', value: '417' },
        { label: 'Game Elements', value: '913' },
        { label: 'Game Ranking System', value: '419' },
        { label: 'Gamers', value: '420' },
        { label: 'Gangs', value: '421' },
        { label: 'Gate to Another World', value: '422' },
        { label: 'Genderless Protagonist', value: '423' },
        { label: 'Generals', value: '424' },
        { label: 'Genetic Modifications', value: '425' },
        { label: 'Genies', value: '426' },
        { label: 'Genius Protagonist', value: '427' },
        { label: 'Ghosts', value: '428' },
        { label: 'Girl_s Love Subplot', value: '759' },
        { label: 'Gladiators', value: '429' },
        { label: 'Glasses-wearing Love Interests', value: '430' },
        { label: 'Glasses-wearing Protagonist', value: '431' },
        { label: 'Goblins', value: '432' },
        { label: 'God Protagonist', value: '433' },
        { label: 'God-human Relationship', value: '434' },
        { label: 'Goddesses', value: '435' },
        { label: 'Godly Powers', value: '436' },
        { label: 'Gods', value: '437' },
        { label: 'Golems', value: '438' },
        { label: 'Gore', value: '439' },
        { label: 'Grave Keepers', value: '440' },
        { label: 'Grinding', value: '441' },
        { label: 'Guardian Relationship', value: '442' },
        { label: 'Guilds', value: '443' },
        { label: 'Gunfighters', value: '444' },
        { label: 'Hackers', value: '445' },
        { label: 'Half-human Protagonist', value: '446' },
        { label: 'Handjob', value: '447' },
        { label: 'Handsome Male Lead', value: '448' },
        { label: 'Hard-Working Protagonist', value: '449' },
        { label: 'Harem-seeking Protagonist', value: '450' },
        { label: 'Harsh Training', value: '451' },
        { label: 'Hated Protagonist', value: '452' },
        { label: 'Healers', value: '453' },
        { label: 'Healing', value: '942' },
        { label: 'Heartwarming', value: '454' },
        { label: 'Heaven', value: '455' },
        { label: 'Heavenly Tribulation', value: '456' },
        { label: 'Hell', value: '457' },
        { label: 'Helpful Protagonist', value: '458' },
        { label: 'Herbalist', value: '459' },
        { label: 'Heroes', value: '460' },
        { label: 'Heterochromia', value: '461' },
        { label: 'Hidden Abilities', value: '462' },
        { label: 'Hiding True Abilities', value: '463' },
        { label: 'Hiding True Identity', value: '464' },
        { label: 'Hikikomori', value: '465' },
        { label: 'Homunculus', value: '466' },
        { label: 'Honest Protagonist', value: '467' },
        { label: 'Hospital', value: '468' },
        { label: 'Hot-blooded Protagonist', value: '469' },
        { label: 'Human Experimentation', value: '470' },
        { label: 'Human Weapon', value: '471' },
        { label: 'Human-Nonhuman Relationship', value: '472' },
        { label: 'Humanoid Protagonist', value: '473' },
        { label: 'Hunters', value: '474' },
        { label: 'Hypnotism', value: '475' },
        { label: 'Identity Crisis', value: '476' },
        { label: 'Imaginary Friend', value: '477' },
        { label: 'Immortals', value: '478' },
        { label: 'Imperial Harem', value: '479' },
        { label: 'Incest', value: '480' },
        { label: 'Incubus', value: '481' },
        { label: 'Indecisive Protagonist', value: '482' },
        { label: 'Industrialization', value: '483' },
        { label: 'Inferiority Complex', value: '484' },
        { label: 'Inheritance', value: '485' },
        { label: 'Inscriptions', value: '486' },
        { label: 'Insects', value: '487' },
        { label: 'Interconnected Storylines', value: '488' },
        { label: 'Interdimensional Travel', value: '489' },
        { label: 'Introverted Protagonist', value: '490' },
        { label: 'Investigations', value: '491' },
        { label: 'Invisibility', value: '492' },
        { label: 'Jack of All Trades', value: '493' },
        { label: 'Jealousy', value: '494' },
        { label: 'Jiangshi', value: '495' },
        { label: 'Jobless Class', value: '496' },
        { label: 'Kidnappings', value: '498' },
        { label: 'Kind Love Interests', value: '499' },
        { label: 'Kingdom Building', value: '500' },
        { label: 'Kingdoms', value: '501' },
        { label: 'Knights', value: '502' },
        { label: 'Kuudere', value: '503' },
        { label: 'Lack of Common Sense', value: '504' },
        { label: 'Language Barrier', value: '505' },
        { label: 'Late Romance', value: '506' },
        { label: 'Lawyers', value: '507' },
        { label: 'Lazy Protagonist', value: '508' },
        { label: 'Leadership', value: '509' },
        { label: 'Legends', value: '510' },
        { label: 'Level System', value: '511' },
        { label: 'Library', value: '512' },
        { label: 'Limited Lifespan', value: '513' },
        { label: 'Living Abroad', value: '514' },
        { label: 'Living Alone', value: '515' },
        { label: 'Loli', value: '516' },
        { label: 'Loneliness', value: '517' },
        { label: 'Loner Protagonist', value: '518' },
        { label: 'Long Separations', value: '519' },
        { label: 'Long-distance Relationship', value: '520' },
        { label: 'Lost Civilizations', value: '521' },
        { label: 'Lottery', value: '522' },
        { label: 'Love at First Sight', value: '523' },
        { label: 'Love Interest Falls in Love First', value: '524' },
        { label: 'Love Rivals', value: '525' },
        { label: 'Love Triangles', value: '526' },
        { label: 'Lovers Reunited', value: '527' },
        { label: 'Low-key Protagonist', value: '528' },
        { label: 'Loyal Subordinates', value: '529' },
        { label: 'Lucky Protagonist', value: '530' },
        { label: 'Magic', value: '531' },
        { label: 'Magic Beasts', value: '532' },
        { label: 'Magic Formations', value: '533' },
        { label: 'Magical Girls', value: '534' },
        { label: 'Magical Space', value: '535' },
        { label: 'Magical Technology', value: '536' },
        { label: 'Maids', value: '537' },
        { label: 'Male Protagonist', value: '538' },
        { label: 'Male to Female', value: '539' },
        { label: 'Male Yandere', value: '540' },
        { label: 'Management', value: '541' },
        { label: 'Mangaka', value: '542' },
        { label: 'Manipulative Characters', value: '543' },
        { label: 'Manly Gay Couple', value: '544' },
        { label: 'Marriage', value: '545' },
        { label: 'Marriage of Convenience', value: '546' },
        { label: 'Martial Spirits', value: '547' },
        { label: 'Masochistic Characters', value: '548' },
        { label: 'Master-Disciple Relationship', value: '549' },
        { label: 'Master-Servant Relationship', value: '550' },
        { label: 'Masturbation', value: '551' },
        { label: 'Matriarchy', value: '552' },
        { label: 'Mature Protagonist', value: '553' },
        { label: 'Medical Knowledge', value: '554' },
        { label: 'Medieval', value: '555' },
        { label: 'Mercenaries', value: '556' },
        { label: 'Merchants', value: '557' },
        { label: 'Military', value: '558' },
        { label: 'Mind Break', value: '559' },
        { label: 'Mind Control', value: '560' },
        { label: 'Misandry', value: '561' },
        { label: 'Mismatched Couple', value: '562' },
        { label: 'Misunderstandings', value: '563' },
        { label: 'MMORPG', value: '564' },
        { label: 'Mob Protagonist', value: '565' },
        { label: 'Models', value: '566' },
        { label: 'Modern Day', value: '567' },
        { label: 'Modern Fantasy', value: '1268' },
        { label: 'Modern Knowledge', value: '568' },
        { label: 'Modern Time', value: '1536' },
        { label: 'Money Grubber', value: '569' },
        { label: 'Monster Girls', value: '570' },
        { label: 'Monster Society', value: '571' },
        { label: 'Monster Tamer', value: '572' },
        { label: 'Monsters', value: '573' },
        { label: 'Movies', value: '574' },
        { label: 'Mpreg', value: '575' },
        { label: 'Multiple Identities', value: '576' },
        { label: 'Multiple Personalities', value: '577' },
        { label: 'Multiple POV', value: '578' },
        { label: 'Multiple Protagonists', value: '579' },
        { label: 'Multiple Realms', value: '580' },
        { label: 'Multiple Reincarnated Individuals', value: '581' },
        { label: 'Multiple Timelines', value: '582' },
        { label: 'Multiple Transported Individuals', value: '583' },
        { label: 'Murders', value: '584' },
        { label: 'Music', value: '585' },
        { label: 'Mutated Creatures', value: '586' },
        { label: 'Mutations', value: '587' },
        { label: 'Mute Character', value: '588' },
        { label: 'Mysterious Family Background', value: '589' },
        { label: 'Mysterious Illness', value: '590' },
        { label: 'Mysterious Past', value: '591' },
        { label: 'Mystery Solving', value: '592' },
        { label: 'Mythical Beasts', value: '593' },
        { label: 'Mythology', value: '594' },
        { label: 'Naive Protagonist', value: '595' },
        { label: 'Narcissistic Protagonist', value: '596' },
        { label: 'Nationalism', value: '597' },
        { label: 'Near-Death Experience', value: '598' },
        { label: 'Necromancer', value: '599' },
        { label: 'Neet', value: '600' },
        { label: 'Netorare', value: '601' },
        { label: 'Netorase', value: '602' },
        { label: 'Netori', value: '603' },
        { label: 'Nightmares', value: '604' },
        { label: 'Ninjas', value: '605' },
        { label: 'Nobles', value: '606' },
        { label: 'Non-human Protagonist', value: '1428' },
        { label: 'Non-humanoid Protagonist', value: '607' },
        { label: 'Non-linear Storytelling', value: '608' },
        { label: 'Nudity', value: '609' },
        { label: 'Nurses', value: '610' },
        { label: 'Obsessive Love', value: '611' },
        { label: 'Office Romance', value: '612' },
        { label: 'Older Love Interests', value: '613' },
        { label: 'Omegaverse', value: '614' },
        { label: 'Oneshot', value: '615' },
        { label: 'Online Romance', value: '616' },
        { label: 'Onmyouji', value: '617' },
        { label: 'Orcs', value: '618' },
        { label: 'Organized Crime', value: '619' },
        { label: 'Orphans', value: '621' },
        { label: 'Otaku', value: '622' },
        { label: 'Otome Game', value: '623' },
        { label: 'Outcasts', value: '624' },
        { label: 'Outdoor Intercourse', value: '625' },
        { label: 'Outer Space', value: '626' },
        { label: 'Overpowered Protagonist', value: '627' },
        { label: 'Overprotective Siblings', value: '628' },
        { label: 'Pacifist Protagonist', value: '629' },
        { label: 'Paizuri', value: '630' },
        { label: 'Pansexual Protagonist', value: '1037' },
        { label: 'Parallel Worlds', value: '631' },
        { label: 'Parasites', value: '632' },
        { label: 'Parent Complex', value: '633' },
        { label: 'Parody', value: '634' },
        { label: 'Part-Time Job', value: '635' },
        { label: 'Past Plays a Big Role', value: '636' },
        { label: 'Past Trauma', value: '637' },
        { label: 'Persistent Love Interests', value: '638' },
        { label: 'Personality Changes', value: '639' },
        { label: 'Perverted Protagonist', value: '640' },
        { label: 'Pets', value: '641' },
        { label: 'Pharmacist', value: '642' },
        { label: 'Philosophical', value: '643' },
        { label: 'Phobias', value: '644' },
        { label: 'Phoenixes', value: '645' },
        { label: 'Photography', value: '646' },
        { label: 'Pill Based Cultivation', value: '647' },
        { label: 'Pill Concocting', value: '648' },
        { label: 'Pilots', value: '649' },
        { label: 'Pirates', value: '650' },
        { label: 'Playboys', value: '651' },
        { label: 'Playful Protagonist', value: '652' },
        { label: 'Poetry', value: '653' },
        { label: 'Poisons', value: '654' },
        { label: 'Police', value: '655' },
        { label: 'Polite Protagonist', value: '656' },
        { label: 'Politics', value: '657' },
        { label: 'Polyandry', value: '658' },
        { label: 'Polygamy', value: '659' },
        { label: 'Poor Protagonist', value: '660' },
        { label: 'Poor to Rich', value: '661' },
        { label: 'Popular Love Interests', value: '662' },
        { label: 'Possession', value: '663' },
        { label: 'Possessive Characters', value: '664' },
        { label: 'Post-apocalyptic', value: '665' },
        { label: 'Power Couple', value: '666' },
        { label: 'Power Struggle', value: '667' },
        { label: 'Pragmatic Protagonist', value: '668' },
        { label: 'Precognition', value: '669' },
        { label: 'Pregnancy', value: '670' },
        { label: 'Pretend Lovers', value: '671' },
        { label: 'Previous Life Talent', value: '672' },
        { label: 'Priestesses', value: '673' },
        { label: 'Priests', value: '674' },
        { label: 'Prison', value: '675' },
        { label: 'Proactive Protagonist', value: '676' },
        { label: 'Programmer', value: '677' },
        { label: 'Prophecies', value: '678' },
        { label: 'Prostitutes', value: '679' },
        { label: 'Protagonist Falls in Love First', value: '680' },
        { label: 'Protagonist Loyal to Love Interest', value: '681' },
        { label: 'Protagonist Strong from the Start', value: '682' },
        { label: 'Protagonist with Multiple Bodies', value: '683' },
        { label: 'Psychic Powers', value: '684' },
        { label: 'Psychopaths', value: '685' },
        { label: 'Puppeteers', value: '686' },
        { label: 'Quiet Characters', value: '687' },
        { label: 'Quirky Characters', value: '688' },
        { label: 'R-15', value: '689' },
        { label: 'R-18', value: '690' },
        { label: 'Race Change', value: '691' },
        { label: 'Racism', value: '692' },
        { label: 'Rape', value: '693' },
        { label: 'Rebellion', value: '695' },
        { label: 'Reincarnated as a Monster', value: '696' },
        { label: 'Reincarnated as an Object', value: '697' },
        { label: 'Reincarnated into a Game World', value: '698' },
        { label: 'Reincarnated into Another World', value: '699' },
        { label: 'Reincarnation', value: '700' },
        { label: 'Religions', value: '701' },
        { label: 'Reluctant Protagonist', value: '702' },
        { label: 'Reporters', value: '703' },
        { label: 'Restaurant', value: '704' },
        { label: 'Resurrection', value: '705' },
        { label: 'Returning from Another World', value: '706' },
        { label: 'Revenge', value: '707' },
        { label: 'Reverse Harem', value: '708' },
        { label: 'Reverse Rape', value: '709' },
        { label: 'Rich to Poor', value: '710' },
        { label: 'Righteous Protagonist', value: '711' },
        { label: 'Rivalry', value: '712' },
        { label: 'Romantic Subplot', value: '713' },
        { label: 'Roommates', value: '714' },
        { label: 'Royalty', value: '715' },
        { label: 'RPG', value: '1089' },
        { label: 'Ruthless Protagonist', value: '716' },
        { label: 'Sadistic Characters', value: '717' },
        { label: 'Saints', value: '718' },
        { label: 'Salaryman', value: '719' },
        { label: 'Samurai', value: '720' },
        { label: 'Satire', value: '1976' },
        { label: 'Saving the World', value: '721' },
        { label: 'Scheming', value: '722' },
        { label: 'Schizophrenia', value: '723' },
        { label: 'Scientists', value: '724' },
        { label: 'Sculptors', value: '725' },
        { label: 'Sealed Power', value: '726' },
        { label: 'Second Chance', value: '727' },
        { label: 'Secret Crush', value: '728' },
        { label: 'Secret Identity', value: '729' },
        { label: 'Secret Organizations', value: '730' },
        { label: 'Secret Relationship', value: '731' },
        { label: 'Secretive Protagonist', value: '732' },
        { label: 'Secrets', value: '733' },
        { label: 'Sect Development', value: '734' },
        { label: 'Seduction', value: '735' },
        { label: 'Seeing Things Other Humans Can_t', value: '736' },
        { label: 'Selfish Protagonist', value: '737' },
        { label: 'Selfless Protagonist', value: '738' },
        { label: 'Seme Protagonist', value: '739' },
        { label: 'Senpai-Kouhai Relationship', value: '740' },
        { label: 'Sentient Objects', value: '741' },
        { label: 'Sentimental Protagonist', value: '742' },
        { label: 'Serial Killers', value: '743' },
        { label: 'Servants', value: '744' },
        { label: 'Seven Deadly Sins', value: '745' },
        { label: 'Seven Virtues', value: '746' },
        { label: 'Sex Friends', value: '747' },
        { label: 'Sexual Abuse', value: '749' },
        { label: 'Sexual Cultivation Technique', value: '750' },
        { label: 'Shameless Protagonist', value: '751' },
        { label: 'Shapeshifters', value: '752' },
        { label: 'Sharing A Body', value: '753' },
        { label: 'Sharp-tongued Characters', value: '754' },
        { label: 'Shield User', value: '755' },
        { label: 'Shikigami', value: '756' },
        { label: 'Short Story', value: '757' },
        { label: 'Shota', value: '758' },
        { label: 'Showbiz', value: '761' },
        { label: 'Shy Characters', value: '762' },
        { label: 'Sibling Rivalry', value: '763' },
        { label: 'Siblings', value: '765' },
        { label: 'Siblings Care', value: '764' },
        { label: 'Siblings Not Related by Blood', value: '766' },
        { label: 'Sickly Characters', value: '767' },
        { label: 'Sign Language', value: '768' },
        { label: 'Singers', value: '769' },
        { label: 'Single Parent', value: '770' },
        { label: 'Sister Complex', value: '771' },
        { label: 'Skill Assimilation', value: '772' },
        { label: 'Skill Books', value: '773' },
        { label: 'Skill Creation', value: '774' },
        { label: 'Slave Harem', value: '775' },
        { label: 'Slave Protagonist', value: '776' },
        { label: 'Slaves', value: '777' },
        { label: 'Sleeping', value: '778' },
        { label: 'Slow Growth at Start', value: '779' },
        { label: 'Slow Romance', value: '780' },
        { label: 'Smart Couple', value: '781' },
        { label: 'Social Outcasts', value: '782' },
        { label: 'Soldiers', value: '783' },
        { label: 'Soul Power', value: '784' },
        { label: 'Souls', value: '785' },
        { label: 'Spatial Manipulation', value: '786' },
        { label: 'Spear Wielder', value: '787' },
        { label: 'Special Abilities', value: '788' },
        { label: 'Special Forces', value: '497' },
        { label: 'Spies', value: '789' },
        { label: 'Spirit Advisor', value: '790' },
        { label: 'Spirit Users', value: '791' },
        { label: 'Spirits', value: '792' },
        { label: 'Stalkers', value: '793n' },
        { label: 'Stockholm Syndrome', value: '794' },
        { label: 'Stoic Characters', value: '795' },
        { label: 'Store Owner', value: '796' },
        { label: 'Straight Seme', value: '797' },
        { label: 'Straight Uke', value: '798' },
        { label: 'Strategic Battles', value: '799' },
        { label: 'Strategist', value: '800' },
        { label: 'Strength-based Social Hierarchy', value: '801' },
        { label: 'Strong Love Interests', value: '802' },
        { label: 'Strong to Stronger', value: '803' },
        { label: 'Stubborn Protagonist', value: '804' },
        { label: 'Student Council', value: '805' },
        { label: 'Student-Teacher Relationship', value: '806' },
        { label: 'Subtle Romance', value: '807' },
        { label: 'Succubus', value: '808' },
        { label: 'Sudden Strength Gain', value: '809' },
        { label: 'Sudden Wealth', value: '810' },
        { label: 'Suicides', value: '811' },
        { label: 'Summoned Hero', value: '812' },
        { label: 'Summoning Magic', value: '813' },
        { label: 'Superheroes', value: '44746' },
        { label: 'Survival', value: '814' },
        { label: 'Survival Game', value: '815' },
        { label: 'Sword And Magic', value: '816' },
        { label: 'Sword Wielder', value: '817' },
        { label: 'System Administrator', value: '818' },
        { label: 'Teachers', value: '819' },
        { label: 'Teamwork', value: '820' },
        { label: 'Technological Gap', value: '821' },
        { label: 'Tentacles', value: '822' },
        { label: 'Terminal Illness', value: '823' },
        { label: 'Terrorists', value: '824' },
        { label: 'Thieves', value: '825' },
        { label: 'Threesome', value: '826' },
        { label: 'Thriller', value: '827' },
        { label: 'Time Loop', value: '828' },
        { label: 'Time Manipulation', value: '829' },
        { label: 'Time Paradox', value: '830' },
        { label: 'Time Skip', value: '831' },
        { label: 'Time Travel', value: '832' },
        { label: 'Timid Protagonist', value: '833' },
        { label: 'Tomboyish Female Lead', value: '834' },
        { label: 'Torture', value: '835' },
        { label: 'Toys', value: '836' },
        { label: 'Tragic Past', value: '837' },
        { label: 'Transformation Ability', value: '838' },
        { label: 'Transgender', value: '1088' },
        { label: 'Transmigration', value: '839' },
        { label: 'Transplanted Memories', value: '840' },
        { label: 'Transported into a Game World', value: '841' },
        { label: 'Transported into Another World', value: '842' },
        { label: 'Transported Modern Structure', value: '843' },
        { label: 'Trap', value: '844' },
        { label: 'Tribal Society', value: '845' },
        { label: 'Trickster', value: '846' },
        { label: 'Trolls', value: '1071' },
        { label: 'Tsundere', value: '847' },
        { label: 'Twins', value: '848' },
        { label: 'Twisted Personality', value: '849' },
        { label: 'Ugly Protagonist', value: '850' },
        { label: 'Ugly to Beautiful', value: '851' },
        { label: 'Unconditional Love', value: '852' },
        { label: 'Underestimated Protagonist', value: '853' },
        { label: 'Unique Cultivation Technique', value: '854' },
        { label: 'Unique Weapon User', value: '855' },
        { label: 'Unique Weapons', value: '856' },
        { label: 'Unlucky Protagonist', value: '857' },
        { label: 'Unreliable Narrator', value: '858' },
        { label: 'Unrequited Love', value: '859' },
        { label: 'Valkyries', value: '860' },
        { label: 'Vampires', value: '861' },
        { label: 'Villainess Noble Girls', value: '862' },
        { label: 'Virtual Reality', value: '863' },
        { label: 'Vocaloid', value: '864' },
        { label: 'Voice Actors', value: '865' },
        { label: 'Voyeurism', value: '866' },
        { label: 'Waiters', value: '867' },
        { label: 'War Records', value: '868' },
        { label: 'Wars', value: '869' },
        { label: 'Weak Protagonist', value: '870' },
        { label: 'Weak to Strong', value: '871' },
        { label: 'Wealthy Characters', value: '872' },
        { label: 'Werebeasts', value: '873' },
        { label: 'Wishes', value: '874' },
        { label: 'Witches', value: '875' },
        { label: 'Wizards', value: '876' },
        { label: 'World Hopping', value: '877' },
        { label: 'World Invasion', value: '1036' },
        { label: 'World Travel', value: '878' },
        { label: 'World Tree', value: '879' },
        { label: 'Writers', value: '880' },
        { label: 'Wuxia', value: '1143' },
        { label: 'Xianxia', value: '1142' },
        { label: 'Xuanhuan', value: '1141' },
        { label: 'Yandere', value: '881' },
        { label: 'Youkai', value: '882' },
        { label: 'Younger Brothers', value: '883' },
        { label: 'Younger Love Interests', value: '884' },
        { label: 'Younger Sisters', value: '885' },
        { label: 'Zombies', value: '886' },
      ],
      type: FilterTypes.ExcludableCheckboxGroup,
    },
    content_warning_operator: {
      value: 'and',
      label: 'Mature Content (And/Or)',
      options: [
        { label: 'And', value: 'and' },
        { label: 'Or', value: 'or' },
      ],
      type: FilterTypes.Picker,
    },
    content_warning: {
      value: {
        include: [],
        exclude: [],
      },
      label: 'Mature Content',
      options: [
        { label: 'Gore', value: '48' },
        { label: 'Sexual Content', value: '50' },
        { label: 'Strong Language', value: '49' },
      ],
      type: FilterTypes.ExcludableCheckboxGroup,
    },
  } satisfies Filters;
}

export default new ScribbleHubPlugin();
