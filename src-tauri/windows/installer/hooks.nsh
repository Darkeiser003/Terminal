; Ganchos del instalador NSIS de WTerminal (bundle > windows > nsis >
; installerHooks). La plantilla propia (installer.nsi, la de Tauri con tres
; cambios) incluye este archivo dos veces: al principio, para los macros
; NSIS_HOOK_*, y después de cargar los idiomas con WTERMINAL_LATE definido,
; para las variables, la página de componentes y sus textos en 15 idiomas,
; que necesitan las variables de la plantilla y los ${LANG_*}.

!ifndef WTERMINAL_LATE

; Al instalar con la interfaz, la página de componentes deja lo elegido en
; first-run.json, junto al ejecutable. WTerminal lo aplica en el primer
; arranque de cada usuario (`platform::first_run`): PATH, y menú del
; Explorador con el protocolo wterminal://. En modo silencioso (/S), pasivo
; (/P) o al actualizar (/UPDATE) no se escribe: queda lo de fábrica, igual
; que antes de existir la página (la suite del instalador no cambia).
!macro NSIS_HOOK_POSTINSTALL
  ${If} $WtComponentsShown = 1
    FileOpen $0 "$INSTDIR\first-run.json" w
    ${If} $0 != ""
      StrCpy $1 "false"
      ${If} $WtPathState = ${BST_CHECKED}
        StrCpy $1 "true"
      ${EndIf}
      StrCpy $2 "false"
      ${If} $WtExplorerState = ${BST_CHECKED}
        StrCpy $2 "true"
      ${EndIf}
      FileWrite $0 '{"version":1,"path":$1,"explorer":$2}$\r$\n'
      FileClose $0
    ${EndIf}
  ${EndIf}
!macroend

; Antes de borrar el programa, el propio ejecutable deshace lo que registró en
; el perfil del usuario: su carpeta y las `bin` de herramientas en el PATH de
; HKCU (solo las que añadió él), los menús «Abrir con WTerminal», App Paths, el
; protocolo wterminal:// y la marca RUNASADMIN (`platform::uninstall_cleanup`).
; Lo que registró otra copia que sigue existiendo (un portable) no se toca.
; En una actualización (/UPDATE) no se deshace nada: la versión nueva lo usa.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --wterminal-uninstall-cleanup'
    ${EndIf}
  ${EndIf}
!macroend

; Una subcarpeta de la carpeta propia, solo si el informe de la app la da por
; borrable ([delete] <nombre>=1, `platform::first_run::store_plan`). Los
; nombres van fijos aquí, los mismos que `first_run::STORE_SUBDIRS`: el informe
; nunca convierte en borrable otra ruta. WT_REPORT lo define la plantilla
; (installer.nsi), que deja el informe en $PLUGINSDIR hasta la sección
; Uninstall: el macro solo se expande allí, cuando ya está definido.
!macro WT_DELETE_STORE_DIR NAME
  ReadINIStr $0 "${WT_REPORT}" "delete" "${NAME}"
  ${If} $0 == "1"
    RmDir /r "$WtStorePath\${NAME}"
  ${EndIf}
!macroend

; Con la casilla «Borrar los datos de la aplicación», Tauri borra las carpetas
; con el identificador del paquete, pero WTerminal guarda lo suyo por nombre:
; ajustes y registros en %APPDATA%\wterminal, y el perfil de Clink y la caché
; del portable en %LOCALAPPDATA%\WTerminal. La carpeta propia va aparte, con
; su propia casilla y su tamaño: borrar los datos nunca se la lleva, ni la de
; fábrica (%LOCALAPPDATA%\WTerminal\entornos) ni otra que cuelgue de ahí
; ($WtDataKeep, del informe; «*» si es la propia %LOCALAPPDATA%\WTerminal).
;
; «Borrar la carpeta propia» solo sale si es de WTerminal
; (`--wterminal-uninstall-report`) y nunca borra la raíz entera: solo las
; subcarpetas de lo que se recupera solo o desde WTerminal (cachés, descargas,
; modelos de IA, herramientas, historial y plugins) y las que no tienen nada.
; Toolchains, programas, proyectos, configuración, lo traído con «Traer lo ya
; instalado» y lo que no es de WTerminal se quedan, y la casilla lo dice
; ($WtStoreKept). La marca solo se va si no queda nada, y la raíz si quedó
; vacía. Las carpetas propias de cada categoría fuera de la raíz
; (toolchainStoreCategoryDirs) no se tocan: las eligió el usuario y no llevan
; marca.
;
; first-run.json lo escribe la página de componentes (POSTINSTALL) y la
; plantilla no lo conoce: sin borrarlo, la carpeta del programa se quedaba y
; una instalación posterior en silencio aplicaba las elecciones viejas.
;
; En silencio (/S) no hay página de confirmación: las dos casillas valen 0 y
; no se borra ningún dato (la suite del instalador lo da por hecho).
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Delete "$INSTDIR\first-run.json"
    RMDir "$INSTDIR"
    SetShellVarContext current
    ${If} $DeleteAppDataCheckboxState = 1
      RmDir /r "$APPDATA\wterminal"
      ; Todo %LOCALAPPDATA%\WTerminal menos la carpeta propia.
      ${If} $WtDataKeep != "*"
        FindFirst $0 $1 "$LOCALAPPDATA\WTerminal\*"
        ${DoWhile} $1 != ""
          ${If} $1 != "."
          ${AndIf} $1 != ".."
          ${AndIf} $1 != "entornos"
          ${AndIf} $1 != $WtDataKeep
            ${If} ${FileExists} "$LOCALAPPDATA\WTerminal\$1\*"
              RmDir /r "$LOCALAPPDATA\WTerminal\$1"
            ${Else}
              Delete "$LOCALAPPDATA\WTerminal\$1"
            ${EndIf}
          ${EndIf}
          FindNext $0 $1
        ${Loop}
        FindClose $0
      ${EndIf}
    ${EndIf}
    ${If} $DeleteStoreCheckboxState = 1
    ${AndIf} $WtStorePath != ""
      !insertmacro WT_DELETE_STORE_DIR "cache"
      !insertmacro WT_DELETE_STORE_DIR "descargas"
      !insertmacro WT_DELETE_STORE_DIR "ia"
      !insertmacro WT_DELETE_STORE_DIR "herramientas"
      !insertmacro WT_DELETE_STORE_DIR "historial"
      !insertmacro WT_DELETE_STORE_DIR "toolchains"
      !insertmacro WT_DELETE_STORE_DIR "programas"
      !insertmacro WT_DELETE_STORE_DIR "proyectos"
      !insertmacro WT_DELETE_STORE_DIR "configuracion"
      !insertmacro WT_DELETE_STORE_DIR "plugins"
      ${If} $WtStoreKept == ""
        Delete "$WtStorePath\LEEME-carpeta-propia-WTerminal.txt"
      ${EndIf}
      RMDir "$WtStorePath"
    ${EndIf}
    ; Si no queda nada, la carpeta vacía también sobra.
    RmDir "$LOCALAPPDATA\WTerminal"
  ${EndIf}
!macroend

!else ; WTERMINAL_LATE

Var WtComponentsShown
Var WtPathBox
Var WtExplorerBox
Var WtPathState
Var WtExplorerState

; Página de componentes. Lo que no es la app (shells, autocompletado,
; paquetes, LTools) se instala desde la propia WTerminal, en una pestaña
; visible: aquí solo se elige cómo se integra con Windows.
Function WtComponentsPage
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(wtComponentsTitle)" "$(wtComponentsSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 20u "$(wtPath)"
  Pop $WtPathBox
  ${NSD_Check} $WtPathBox
  ${NSD_CreateCheckbox} 0 26u 100% 20u "$(wtExplorer)"
  Pop $WtExplorerBox
  ${NSD_Check} $WtExplorerBox
  ${NSD_CreateLabel} 0 56u 100% 60u "$(wtComponentsNote)"
  Pop $0
  StrCpy $WtComponentsShown 1
  nsDialogs::Show
FunctionEnd

Function WtComponentsLeave
  ${NSD_GetState} $WtPathBox $WtPathState
  ${NSD_GetState} $WtExplorerBox $WtExplorerState
FunctionEnd

; STORE es la casilla «Borrar la carpeta propia» (con lo que se borra) y KEPT
; precede a la lista de lo que se queda, que da la app con los nombres de las
; subcarpetas (toolchains, proyectos…). PROFILES precede a la carpeta de los
; perfiles portables, que se conservan siempre (17-11).
!macro WT_STRINGS LANG TITLE SUBTITLE PATHTEXT EXPLORER NOTE STORE KEPT PROFILES
  !ifdef LANG_${LANG}
    LangString wtComponentsTitle ${LANG_${LANG}} "${TITLE}"
    LangString wtComponentsSubtitle ${LANG_${LANG}} "${SUBTITLE}"
    LangString wtPath ${LANG_${LANG}} "${PATHTEXT}"
    LangString wtExplorer ${LANG_${LANG}} "${EXPLORER}"
    LangString wtComponentsNote ${LANG_${LANG}} "${NOTE}"
    LangString wtDeleteStore ${LANG_${LANG}} "${STORE}"
    LangString wtStoreKept ${LANG_${LANG}} "${KEPT}"
    LangString wtProfilesKept ${LANG_${LANG}} "${PROFILES}"
  !endif
!macroend

!insertmacro WT_STRINGS SPANISH "Componentes" "Elige cómo se integra WTerminal con Windows." "Añadir WTerminal al PATH (para abrirlo desde cualquier terminal)" "Menú «Abrir con WTerminal» en el Explorador y enlaces wterminal://" "Los accesos directos del menú Inicio y del escritorio se eligen después. Shells, sugerencias, paquetes y LTools se instalan desde la propia WTerminal, en una pestaña visible. Todo se puede cambiar luego en Ajustes." "Borrar la carpeta propia: cachés, descargas, modelos de IA, herramientas, historial y plugins de WTerminal" "Se conservan" "Tus perfiles portables se conservan siempre en"
!insertmacro WT_STRINGS ENGLISH "Components" "Choose how WTerminal integrates with Windows." "Add WTerminal to the PATH (to open it from any terminal)" "«Open with WTerminal» in File Explorer and wterminal:// links" "Start menu and desktop shortcuts are chosen later. Shells, suggestions, packages and LTools are installed from WTerminal itself, in a visible tab. Everything can be changed later in Settings." "Delete your own folder: WTerminal caches, downloads, AI models, tools, history and plugins" "Kept" "Your portable profiles are always kept in"
!insertmacro WT_STRINGS FRENCH "Composants" "Choisissez comment WTerminal s'intègre à Windows." "Ajouter WTerminal au PATH (pour l'ouvrir depuis n'importe quel terminal)" "« Ouvrir avec WTerminal » dans l'Explorateur et liens wterminal://" "Les raccourcis du menu Démarrer et du bureau se choisissent ensuite. Shells, suggestions, paquets et LTools s'installent depuis WTerminal, dans un onglet visible. Tout se modifie ensuite dans les réglages." "Supprimer le dossier propre : caches, téléchargements, modèles d'IA, outils, historique et plugins de WTerminal" "Conservés" "Vos profils portables sont toujours conservés dans"
!insertmacro WT_STRINGS GERMAN "Komponenten" "Wähle, wie WTerminal sich in Windows einfügt." "WTerminal zum PATH hinzufügen (aus jedem Terminal startbar)" "„Mit WTerminal öffnen“ im Explorer und wterminal://-Links" "Verknüpfungen im Startmenü und auf dem Desktop werden danach gewählt. Shells, Vorschläge, Pakete und LTools installiert WTerminal selbst in einem sichtbaren Tab. Alles lässt sich später in den Einstellungen ändern." "Eigenen Ordner löschen: Caches, Downloads, KI-Modelle, Werkzeuge, Verlauf und Plugins von WTerminal" "Bleiben erhalten" "Deine portablen Profile bleiben immer erhalten in"
!insertmacro WT_STRINGS ITALIAN "Componenti" "Scegli come WTerminal si integra con Windows." "Aggiungi WTerminal al PATH (per aprirlo da qualsiasi terminale)" "«Apri con WTerminal» in Esplora file e collegamenti wterminal://" "I collegamenti nel menu Start e sul desktop si scelgono dopo. Shell, suggerimenti, pacchetti e LTools si installano da WTerminal, in una scheda visibile. Tutto si può cambiare poi nelle impostazioni." "Elimina la cartella propria: cache, download, modelli di IA, strumenti, cronologia e plugin di WTerminal" "Restano" "I tuoi profili portabili restano sempre in"
!insertmacro WT_STRINGS PORTUGUESE "Componentes" "Escolhe como o WTerminal se integra no Windows." "Adicionar o WTerminal ao PATH (para o abrir em qualquer terminal)" "«Abrir com o WTerminal» no Explorador e ligações wterminal://" "Os atalhos do menu Iniciar e do ambiente de trabalho escolhem-se depois. Shells, sugestões, pacotes e LTools instalam-se a partir do WTerminal, num separador visível. Tudo pode ser alterado depois nas definições." "Apagar a pasta própria: caches, transferências, modelos de IA, ferramentas, histórico e plugins do WTerminal" "Ficam" "Os teus perfis portáteis ficam sempre em"
!insertmacro WT_STRINGS RUSSIAN "Компоненты" "Выберите, как WTerminal встраивается в Windows." "Добавить WTerminal в PATH (запуск из любого терминала)" "«Открыть в WTerminal» в Проводнике и ссылки wterminal://" "Ярлыки в меню «Пуск» и на рабочем столе выбираются дальше. Оболочки, подсказки, пакеты и LTools устанавливаются из самого WTerminal, в видимой вкладке. Всё можно изменить потом в настройках." "Удалить собственную папку: кэши, загрузки, модели ИИ, инструменты, историю и плагины WTerminal" "Остаются" "Ваши переносимые профили всегда сохраняются в"
!insertmacro WT_STRINGS UKRAINIAN "Компоненти" "Виберіть, як WTerminal вбудовується у Windows." "Додати WTerminal до PATH (запуск з будь-якого термінала)" "«Відкрити у WTerminal» у Провіднику та посилання wterminal://" "Ярлики в меню «Пуск» і на робочому столі вибираються далі. Оболонки, підказки, пакети та LTools встановлюються з самого WTerminal, у видимій вкладці. Усе можна змінити потім у налаштуваннях." "Видалити власну теку: кеші, завантаження, моделі ШІ, інструменти, історію та плагіни WTerminal" "Залишаються" "Ваші переносні профілі завжди зберігаються в"
!insertmacro WT_STRINGS POLISH "Składniki" "Wybierz, jak WTerminal integruje się z Windows." "Dodaj WTerminal do PATH (uruchamianie z dowolnego terminala)" "„Otwórz w WTerminal” w Eksploratorze i linki wterminal://" "Skróty w menu Start i na pulpicie wybiera się później. Powłoki, podpowiedzi, pakiety i LTools instaluje się z samego WTerminal, w widocznej karcie. Wszystko można później zmienić w ustawieniach." "Usuń własny folder: pamięci podręczne, pobrane pliki, modele AI, narzędzia, historię i wtyczki WTerminal" "Zostają" "Twoje profile przenośne zawsze zostają w"
!insertmacro WT_STRINGS ROMANIAN "Componente" "Alege cum se integrează WTerminal cu Windows." "Adaugă WTerminal în PATH (pentru a-l deschide din orice terminal)" "„Deschide cu WTerminal” în Explorer și linkuri wterminal://" "Comenzile rapide din meniul Start și de pe desktop se aleg după. Shell-urile, sugestiile, pachetele și LTools se instalează din WTerminal, într-o filă vizibilă. Totul se poate schimba apoi din setări." "Șterge folderul propriu: cache-uri, descărcări, modele AI, instrumente, istoric și pluginuri WTerminal" "Rămân" "Profilurile tale portabile rămân mereu în"
!insertmacro WT_STRINGS ARABIC "المكوّنات" "اختر كيف يندمج WTerminal مع Windows." "إضافة WTerminal إلى PATH (لفتحه من أي طرفية)" "«فتح باستخدام WTerminal» في المستكشف وروابط wterminal://" "تُختار اختصارات قائمة ابدأ وسطح المكتب لاحقًا. تُثبَّت الصدفات والاقتراحات والحزم وLTools من WTerminal نفسه في علامة تبويب ظاهرة. يمكن تغيير كل شيء لاحقًا في الإعدادات." "حذف المجلد الخاص: الذاكرة المؤقتة والتنزيلات ونماذج الذكاء الاصطناعي والأدوات والسجل والإضافات من WTerminal" "يُحتفظ بـ" "تبقى ملفاتك الشخصية المحمولة دائمًا في"
!insertmacro WT_STRINGS JAPANESE "コンポーネント" "WTerminal と Windows の連携方法を選んでください。" "WTerminal を PATH に追加（どのターミナルからでも起動）" "エクスプローラーの「WTerminal で開く」と wterminal:// リンク" "スタートメニューとデスクトップのショートカットはこの後で選びます。シェル、候補表示、パッケージ、LTools は WTerminal から表示中のタブでインストールします。すべて後から設定で変更できます。" "専用フォルダーを削除：WTerminal のキャッシュ、ダウンロード、AI モデル、ツール、履歴、プラグイン" "残すもの" "ポータブルプロファイルは常にここに残ります"
!insertmacro WT_STRINGS KOREAN "구성 요소" "WTerminal이 Windows와 통합되는 방식을 고르세요." "WTerminal을 PATH에 추가(어느 터미널에서나 실행)" "탐색기의 「WTerminal로 열기」와 wterminal:// 링크" "시작 메뉴와 바탕 화면 바로 가기는 다음에 고릅니다. 셸, 제안, 패키지, LTools는 WTerminal에서 보이는 탭으로 설치합니다. 모두 나중에 설정에서 바꿀 수 있습니다." "전용 폴더 삭제: WTerminal의 캐시, 다운로드, AI 모델, 도구, 기록, 플러그인" "유지됨" "휴대용 프로필은 항상 여기에 남습니다"
!insertmacro WT_STRINGS SIMPCHINESE "组件" "选择 WTerminal 与 Windows 的集成方式。" "将 WTerminal 添加到 PATH（可从任何终端打开）" "资源管理器中的“用 WTerminal 打开”和 wterminal:// 链接" "开始菜单和桌面快捷方式稍后选择。Shell、建议、软件包和 LTools 在 WTerminal 中于可见标签页安装。以后都可在设置中更改。" "删除自有文件夹：WTerminal 的缓存、下载、AI 模型、工具、历史记录和插件" "保留" "你的便携配置文件始终保留在"
!insertmacro WT_STRINGS HINDI "घटक" "चुनें कि WTerminal Windows के साथ कैसे जुड़े।" "WTerminal को PATH में जोड़ें (किसी भी टर्मिनल से खोलने के लिए)" "एक्सप्लोरर में «WTerminal से खोलें» और wterminal:// लिंक" "स्टार्ट मेनू और डेस्कटॉप शॉर्टकट बाद में चुने जाते हैं। शेल, सुझाव, पैकेज और LTools WTerminal से ही, दिखने वाले टैब में इंस्टॉल होते हैं। सब कुछ बाद में सेटिंग्स में बदला जा सकता है।" "अपना फ़ोल्डर हटाएँ: WTerminal के कैश, डाउनलोड, AI मॉडल, टूल, इतिहास और प्लगइन" "बने रहेंगे" "आपकी पोर्टेबल प्रोफ़ाइल हमेशा यहाँ रहती हैं"

!endif ; WTERMINAL_LATE
