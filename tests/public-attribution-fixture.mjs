// Anonymous source structure for tests only; never loaded by the application.
import {publicStage,textHash} from './public-facts-fixture.mjs';
export function attributedStage(input=publicStage()) {
 const x=structuredClone(input),author='Avery Vale',object='Blake Reed';
 const sentence='My friend Blake Reed recently shared a book.';
 const text=author+' '+sentence,start=author.length+1,objectStart=text.indexOf(object);
 const d=x.envelope.documents[0];
 Object.assign(d,{normalizationVersion:'public-source-attributed-v2',metadataStatus:'SOURCE_SUPPLIED_NOT_VERIFIED',
  contentDigest:textHash(text),attribution:{version:'source-declared-author-v1',
   author:{locator:{start:0,end:author.length},declarationKinds:['HTML_META_NAME_AUTHOR','JSONLD_ARTICLE_AUTHOR_NAME']},
   article:{locator:{start,end:text.length},proseRanges:[{start,end:text.length}]}}});
 x.texts[0].normalizedText=text;x.envelope.normalized.records[0].contentDigest=d.contentDigest;
 const ranges=[[0,author.length],[objectStart,objectStart+object.length],[start,text.length]];
 for(const [i,c] of x.envelope.citations.entries()) {
  const [a,b]=ranges[i];c.locator={start:a,end:b,section:null};c.supportingExcerpt=text.slice(a,b);
  x.envelope.normalized.batch.evidence.find(e=>e.id===c.evidenceId).summary=c.supportingExcerpt;
 }
 const p=x.envelope.proposals[0];p.subject.mention=author;p.object.mention=object;
 p.subject.sourceIdentity.platform='PUBLIC_DOCUMENT_MENTION';p.object.sourceIdentity.platform='PUBLIC_DOCUMENT_MENTION';
 Object.assign(p,{predicate:'AUTHORED_FIRST_PERSON_FRIEND_OF',relationshipKind:'FRIEND',support:'DIRECT_EXPLICIT',
  assertedPeriod:{start:null,end:null},extractionUncertainties:[]});
 return x;
}
