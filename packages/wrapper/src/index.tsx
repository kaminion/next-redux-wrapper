import App, {AppContext, AppInitialProps, AppProps} from 'next/app';
import React, {useEffect, useMemo, useRef} from 'react';
import {Provider} from 'react-redux';
import {Store} from 'redux';
import {
    GetServerSideProps,
    GetServerSidePropsContext,
    GetStaticProps,
    GetStaticPropsContext,
    NextComponentType,
    NextPageContext,
} from 'next';
import {useRouter} from 'next/router';

/**
 * Quick note on Next.js return types:
 *
 * Page.getInitialProps https://nextjs.org/docs/api-reference/data-fetching/getInitialProps
 * as-is
 *
 * App.getInitialProps: AppInitialProps https://nextjs.org/docs/advanced-features/custom-app
 * {pageProps: any}
 *
 * getStaticProps https://nextjs.org/docs/basic-features/data-fetching#getstaticprops-static-generation
 * {props: any}
 *
 * getServerSideProps https://nextjs.org/docs/basic-features/data-fetching#getserversideprops-server-side-rendering
 * {props: any}
 */

export const HYDRATE = '__NEXT_REDUX_WRAPPER_HYDRATE__';

const getIsServer = () => typeof window === 'undefined';

const getDeserializedState = <S extends Store>(initialState: any, {deserializeState}: Config<S> = {}) =>
    deserializeState ? deserializeState(initialState) : initialState;

const getSerializedState = <S extends Store>(state: any, {serializeState}: Config<S> = {}) =>
    serializeState ? serializeState(state) : state;

export declare type MakeStore<S extends Store> = (context: Context) => S;

export interface InitStoreOptions<S extends Store> {
    makeStore: MakeStore<S>;
    context?: Context;
}

let sharedClientStore: any;

const initStore = <S extends Store>({makeStore, context = {}}: InitStoreOptions<S>): S => {
    const createStore = () => makeStore(context);

    if (getIsServer()) {
        const req: any = (context as NextPageContext)?.req || (context as AppContext)?.ctx?.req;
        if (req) {
            // ATTENTION! THIS IS INTERNAL, DO NOT ACCESS DIRECTLY ANYWHERE ELSE
            // @see https://github.com/kirill-konshin/next-redux-wrapper/pull/196#issuecomment-611673546
            if (!req.__nextReduxWrapperStore) {
                req.__nextReduxWrapperStore = createStore(); // Used in GIP/GSSP
            }
            return req.__nextReduxWrapperStore;
        }
        return createStore();
    }

    // Memoize the store if we're on the client
    if (!sharedClientStore) {
        sharedClientStore = createStore();
    }

    return sharedClientStore;
};

export const createWrapper = <S extends Store>(makeStore: MakeStore<S>, config: Config<S> = {}) => {
    const makeProps = async ({
        callback,
        context,
        addStoreToContext = false,
    }: {
        callback: Callback<S, any>;
        context: any;
        addStoreToContext?: boolean;
    }): Promise<WrapperProps> => {
        const store = initStore({context, makeStore});

        if (config.debug) {
            console.log(`1. getProps created store with state`, store.getState());
        }

        // Legacy stuff - put store in context
        if (addStoreToContext) {
            if (context.ctx) {
                context.ctx.store = store;
            } else {
                context.store = store;
            }
        }

        const nextCallback = callback && callback(store);
        const initialProps = (nextCallback && (await nextCallback(context))) || {};

        if (config.debug) {
            console.log(`3. getProps after dispatches has store state`, store.getState());
        }

        const state = store.getState();

        return {
            initialProps,
            initialState: getIsServer() ? getSerializedState<S>(state, config) : state,
        };
    };

    const getInitialPageProps =
        <P extends {} = any>(callback: PageCallback<S, P>): GetInitialPageProps<P> =>
        async (
            context: NextPageContext | any, // legacy
        ) => {
            // context is store — avoid double-wrapping
            if ('getState' in context) {
                return callback && callback(context as any);
            }
            return await makeProps({callback, context, addStoreToContext: true});
        };

    const getInitialAppProps =
        <P extends {} = any>(callback: AppCallback<S, P>): GetInitialAppProps<P> =>
        async (context: AppContext) => {
            const {initialProps, initialState} = await makeProps({callback, context, addStoreToContext: true});
            return {
                ...initialProps,
                initialState,
            };
        };

    const getStaticProps =
        <P extends {} = any>(callback: GetStaticPropsCallback<S, P>): GetStaticProps<P> =>
        async context => {
            const {initialProps, initialState} = await makeProps({callback, context});
            return {
                ...initialProps,
                props: {
                    ...initialProps.props,
                    initialState,
                },
            } as any;
        };

    const getServerSideProps =
        <P extends {} = any>(callback: GetServerSidePropsCallback<S, P>): GetServerSideProps<P> =>
        async context =>
            await getStaticProps(callback as any)(context); // just not to repeat myself

    const hydrate = (store: S, state: any) => {
        if (!state) {
            return;
        }
        store.dispatch({
            type: HYDRATE,
            payload: getDeserializedState<S>(state, config),
        } as any);
    };

    const hydrateOrchestrator = (store: S, giapState: any, gspState: any, gsspState: any, gippState: any) => {
        if (gspState) {
            // If GSP has run, then gspState will _not_ contain the data from GIP (if it exists), because GSP is run at build time,
            // and GIP runs at request time. So we have to hydrate the GIP data first, and then do another hydrate on the gspState.
            hydrate(store, giapState);
            hydrate(store, gspState);
        } else if (gsspState || gippState || giapState) {
            // If GSSP has run, then gsspState _will_ contain the data from GIP (if there is a GIP) and the GSSP data combined
            // (see https://github.com/kirill-konshin/next-redux-wrapper/pull/499#discussion_r1014500941).
            // If there is no GSP or GSSP for this page, but there is a GIP on page level (not _app), then we use the gippState.
            // If there is no GSP or GSSP and no GIP on page level for this page, but there is a GIP on _app level, then we use the giapState.
            hydrate(store, gsspState ?? gippState ?? giapState);
        }
    };

    const useHybridHydrate = (store: S, giapState: any, gspState: any, gsspState: any, gippState: any) => {
        const {events} = useRouter();
        const shouldHydrate = useRef(true);

        /**
         * Moving this functions outside of the useEffect hook
         * to avoid creating new function references on each render.
         */
        const handleRouteChangeStart = () => {
            shouldHydrate.current = true;
        };

        const handleRouteChangeComplete = () => {
            shouldHydrate.current = false;
        };

        useEffect(() => {
            events?.on('routeChangeStart', handleRouteChangeStart);
            /**
             * Depending on whether the user is navigating to a new route or not.
             * This can help avoid unnecessary hydration of components and potentially improve performance.
             *
             * @see https://nextjs.org/docs/api-reference/next/router#routerevents
             */
            events?.on('routeChangeComplete', handleRouteChangeComplete);

            return () => {
                events?.off('routeChangeStart', handleRouteChangeStart);
                events?.off('routeChangeComplete', handleRouteChangeComplete);
            };
        }, [events]);

        const memoizedHydrateOrchestrator = useMemo(() => {
            /**
             * we are returning a function that will be called when the component is unmounted.
             * This function will check if the shouldHydrate.current flag is true, which means that the router has changed routes,
             * and if it is true, it calls the hydrateOrchestrator function with the necessary states and data.
             */
            return () => {
                if (shouldHydrate.current) {
                    hydrateOrchestrator(store, giapState, gspState, gsspState, gippState);
                }
            };
        }, [store, giapState, gspState, gsspState, gippState]);

        useEffect(() => {
            /**
             * This memoizedHydrateOrchestrator function is being created using the useMemo hook to ensure that the function
             * is only created when any of the dependencies passed in the second argument to useMemo changes.
             *
             * This function checks if the shouldHydrate.current flag is true, which means that the router has changed routes,
             * and if it is true, it calls the hydrateOrchestrator function with the necessary states and data.
             *
             * By memoizing this function, we can ensure that it is only created once and reused on subsequent renders,
             * avoiding unnecessary function calls and potential performance issues.
             */
            memoizedHydrateOrchestrator();
        }, [memoizedHydrateOrchestrator]);
    };

    // giapState stands for getInitialAppProps state
    const useWrappedStore = <P extends AppProps>(incomingProps: P, displayName = 'useWrappedStore'): {store: S; props: P} => {
        // createWrapper adds WrapperProps to incomingProps, they are not present in P so type needs to be coerced here
        const {initialState: giapState, initialProps, ...props} = incomingProps as P & WrapperProps;

        // getStaticProps state
        const gspState = props?.__N_SSG ? props?.pageProps?.initialState : null;
        // getServerSideProps state
        const gsspState = props?.__N_SSP ? props?.pageProps?.initialState : null;
        // getInitialPageProps state
        const gippState = !gspState && !gsspState ? props?.pageProps?.initialState ?? null : null;

        if (config.debug) {
            console.log('4.', displayName, 'created new store with', {
                giapState,
                gspState,
                gsspState,
                gippState,
            });
        }

        const store = useMemo<S>(() => initStore<S>({makeStore}), []);

        useHybridHydrate(store, giapState, gspState, gsspState, gippState);

        let resultProps: any = props;

        // order is important! Next.js overwrites props from pages/_app with getStaticProps from page
        // @see https://github.com/zeit/next.js/issues/11648
        if (initialProps && initialProps.pageProps) {
            resultProps.pageProps = {
                ...initialProps.pageProps, // this comes from wrapper in _app mode
                ...props.pageProps, // this comes from gssp/gsp in _app mode
            };
        }

        // just some cleanup to prevent passing it as props, we need to clone props to safely delete initialState
        if (props?.pageProps?.initialState) {
            resultProps = {...props, pageProps: {...props.pageProps}};
            delete resultProps.pageProps.initialState;
        }

        // unwrap getInitialPageProps
        if (resultProps?.pageProps?.initialProps) {
            resultProps.pageProps = {...resultProps.pageProps, ...resultProps.pageProps.initialProps};
            delete resultProps.pageProps.initialProps;
        }

        return {store, props: {...initialProps, ...resultProps}};
    };

    const withRedux = (Component: NextComponentType | App | any) => {
        console.warn(
            '/!\\ You are using legacy implementation. Please update your code: use createWrapper() and wrapper.useWrappedStore().',
        );

        //TODO Check if pages/_app was wrapped so there's no need to wrap a page itself
        const WrappedComponent = (props: any) => {
            const {store, props: combinedProps} = useWrappedStore(props, WrappedComponent.displayName);

            return (
                <Provider store={store}>
                    <Component {...combinedProps} />
                </Provider>
            );
        };

        WrappedComponent.displayName = `withRedux(${Component.displayName || Component.name || 'Component'})`;

        if ('getInitialProps' in Component) {
            WrappedComponent.getInitialProps = Component.getInitialProps;
        }

        return WrappedComponent;
    };

    return {
        getServerSideProps,
        getStaticProps,
        getInitialAppProps,
        getInitialPageProps,
        withRedux,
        useWrappedStore,
    };
};

// Legacy
// eslint-disable-next-line import/no-anonymous-default-export
export default <S extends Store>(makeStore: MakeStore<S>, config: Config<S> = {}) => {
    console.warn('/!\\ You are using legacy implementation. Please update your code: use createWrapper() and wrapper.withRedux().');
    return createWrapper(makeStore, config).withRedux;
};

export type Context = NextPageContext | AppContext | GetStaticPropsContext | GetServerSidePropsContext;

export interface Config<S extends Store> {
    serializeState?: (state: ReturnType<S['getState']>) => any;
    deserializeState?: (state: any) => ReturnType<S['getState']>;
    debug?: boolean;
}

export interface WrapperProps {
    initialProps: any; // stuff returned from getInitialProps or getServerSideProps
    initialState: any; // stuff in the Store state after getInitialProps
}

type GetInitialPageProps<P> = NextComponentType<NextPageContext, any, P>['getInitialProps'];

//FIXME Could be typeof App.getInitialProps & appGetInitialProps (not exported), see https://github.com/kirill-konshin/next-redux-wrapper/issues/412
type GetInitialAppProps<P> = ({Component, ctx}: AppContext) => Promise<AppInitialProps & {pageProps: P}>;

export type GetStaticPropsCallback<S extends Store, P extends {[key: string]: any}> = (store: S) => GetStaticProps<P>;
export type GetServerSidePropsCallback<S extends Store, P extends {[key: string]: any}> = (store: S) => GetServerSideProps<P>;
export type PageCallback<S extends Store, P> = (store: S) => GetInitialPageProps<P>;
export type AppCallback<S extends Store, P> = (store: S) => GetInitialAppProps<P>;
export type Callback<S extends Store, P extends {[key: string]: any}> =
    | GetStaticPropsCallback<S, P>
    | GetServerSidePropsCallback<S, P>
    | PageCallback<S, P>
    | AppCallback<S, P>;

declare module 'next' {
    export interface NextPageContext<S extends Store = any> {
        //<S = any, A extends Action = AnyAction>
        /**
         * Provided by next-redux-wrapper: The redux store
         */
        store: S;
    }
}